import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests end-to-end de la CLI: se ejecuta `src/cli/index.ts` como proceso real
 * con tsx. Nunca se toca la red: todas las configs usan provider `mock`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const COPY_RECIPE = join(REPO, 'examples', 'copy-checker.json');
const UX_RECIPE = join(REPO, 'examples', 'ux-checker.json');

/** PNG 1x1 válido (magic bytes + IHDR + IEND). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Respuestas de fixture que hacen que copy-checker pase con el provider mock. */
const COPY_FIXTURES = {
  'CP-1': { type: 'score', score: 3, probabilities: {}, confidence: 0.9 },
  'CP-2': { type: 'choice', choice: 'on_brand', probabilities: { on_brand: 0.9 }, confidence: 0.9 },
  'CP-3': { type: 'noul', noul: 0.95 },
  'CP-4': { type: 'noul', noul: 0.95 },
  'CP-5': { type: 'score', score: 2, probabilities: {}, confidence: 0.9 },
};

/** Respuestas de fixture que hacen que ux-checker pase con el provider mock. */
const UX_FIXTURES = {
  'UX-1': { type: 'score', score: 3, probabilities: {}, confidence: 0.9 },
  'UX-2': { type: 'noul', noul: 0.9 },
  'UX-3': { type: 'choice', choice: 'consistente', probabilities: { consistente: 0.9 }, confidence: 0.9 },
  'UX-4': { type: 'noul', noul: 0.9 },
};

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-cli-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ConfigOptions {
  fixtures?: Record<string, unknown>;
  defaultAlias?: string;
}

/** Escribe una config con un único provider `mock` (y fixtures opcionales). */
function writeMockConfig(dir: string, opts: ConfigOptions = {}): string {
  const provider: Record<string, unknown> = { kind: 'mock' };
  if (opts.fixtures) {
    const fixturesDir = join(dir, 'fixtures');
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(join(fixturesDir, 'answers.json'), JSON.stringify(opts.fixtures));
    provider.fixturesDir = fixturesDir;
  }
  const config = {
    default: opts.defaultAlias ?? 'mock',
    providers: { mock: provider },
  };
  const path = join(dir, 'm1.config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string; input?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, join(REPO, 'src', 'cli', 'index.ts'), ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
    input: opts.input,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Parsea el error JSON que la CLI escribe por stderr cuando falla. */
function errorOf(result: CliResult): { code: string; message: string; hint?: string; details?: unknown } {
  const parsed = JSON.parse(result.stderr) as { ok: false; error: { code: string; message: string; hint?: string; details?: unknown } };
  return parsed.error;
}

describe('m1 run', () => {
  it('ejecuta copy-checker con provider mock y devuelve JSON con verdict pass', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir, { fixtures: COPY_FIXTURES });

    const result = cli(['run', COPY_RECIPE, '--state', 'texto', '--json', '-c', config]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      runId: string;
      verdict: string;
      meta: { provider: string };
    };
    expect(out.runId).toMatch(/^run_[0-9a-f]{12}$/);
    expect(out.verdict).toBe('pass');
    expect(out.meta.provider).toBe('mock');
    expect(result.stderr).toBe('');
  });

  it('--compact imprime una sola línea con [PASS]', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir, { fixtures: COPY_FIXTURES });

    const result = cli(['run', COPY_RECIPE, '--state', 'texto', '--compact', '-c', config]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[PASS]');
  });

  it('modo humano (sin --json) imprime score:', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir, { fixtures: COPY_FIXTURES });

    const result = cli(['run', COPY_RECIPE, '--state', 'texto', '-c', config]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('score:');
    expect(result.stdout).toContain('PASS');
  });

  it('--state-file lee el texto desde un archivo', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir, { fixtures: COPY_FIXTURES });
    const stateFile = join(dir, 'copy.txt');
    writeFileSync(stateFile, 'un texto de prueba');

    const result = cli(['run', COPY_RECIPE, '--state-file', stateFile, '--json', '-c', config]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { verdict: string; meta: { calls: number } };
    expect(out.verdict).toBe('pass');
    expect(out.meta.calls).toBe(1);
  });

  it('--stdin acepta un objeto JSON con los slots', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir, { fixtures: COPY_FIXTURES });

    const result = cli(['run', COPY_RECIPE, '--stdin', '--json', '-c', config], {
      input: JSON.stringify({ copy: 'texto por stdin' }),
    });

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { verdict: string; criteria: unknown[] };
    expect(out.verdict).toBe('pass');
    expect(out.criteria.length).toBeGreaterThan(0);
  });

  it('--image envía una imagen y el provider mock responde', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir, { fixtures: UX_FIXTURES });
    const image = join(dir, 'pixel.png');
    writeFileSync(image, PNG_1X1);

    const result = cli(['run', UX_RECIPE, '--image', image, '--json', '-c', config]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { verdict: string; meta: { calls: number } };
    expect(out.verdict).toBe('pass');
    expect(out.meta.calls).toBeGreaterThanOrEqual(1);
  });

  it('--print-request imprime los requests armados (incluidas imágenes)', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    writeFileSync(join(dir, 'pixel.png'), PNG_1X1);

    const copy = cli(['run', COPY_RECIPE, '--state', 'texto', '--print-request', '-c', config]);
    expect(copy.status).toBe(0);
    const copyOut = JSON.parse(copy.stdout) as {
      ok: boolean;
      requests: Array<{ model: string; state: unknown; questions: Record<string, unknown> }>;
    };
    expect(copyOut.ok).toBe(true);
    expect(copyOut.requests.length).toBeGreaterThan(0);
    for (const request of copyOut.requests) {
      expect(typeof request.model).toBe('string');
      expect(request.state).toBeDefined();
      expect(Object.keys(request.questions).length).toBeGreaterThan(0);
    }

    const ux = cli([
      'run',
      UX_RECIPE,
      '--image',
      join(dir, 'pixel.png'),
      '--print-request',
      '-c',
      config,
    ]);
    expect(ux.status).toBe(0);
    const uxOut = JSON.parse(ux.stdout) as { requests: Array<{ images?: Array<{ content_type: string }> }> };
    expect(uxOut.requests.some((r) => (r.images?.length ?? 0) > 0)).toBe(true);
    expect(uxOut.requests[0]?.images?.[0]?.content_type).toBe('image/png');
  });

  it('--dry-run no llama al provider', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['run', COPY_RECIPE, '--state', 'texto', '--dry-run', '--json', '-c', config]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { meta: { dryRun: boolean; calls: number } };
    expect(out.meta.dryRun).toBe(true);
    expect(out.meta.calls).toBe(0);
  });
});

describe('m1 run: errores de entrada y validación', () => {
  it('receta con JSON roto → exit 2 / E_VALIDATION', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{');

    const result = cli(['run', broken, '--state', 'texto', '--json', '-c', config]);

    expect(result.status).toBe(2);
    expect(errorOf(result).code).toBe('E_VALIDATION');
  });

  it('criterio duplicado → exit 2 / E_VALIDATION con details.path', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const recipe = writeJson(dir, 'dup.json', {
      id: 'dup',
      role: 'prueba',
      criteria: [
        { id: 'C1', type: 'noul', instructions: 'primera' },
        { id: 'C1', type: 'noul', instructions: 'duplicada' },
      ],
      stages: [{ id: 'base', questions: ['C1'] }],
    });

    const result = cli(['run', recipe, '--state', 'texto', '--json', '-c', config]);

    expect(result.status).toBe(2);
    const error = errorOf(result);
    expect(error.code).toBe('E_VALIDATION');
    const details = error.details as Array<{ path: string }>;
    expect(details.some((d) => d.path === 'criteria.1.id')).toBe(true);
  });

  it('--input inexistente → exit 2 / E_INPUT', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli([
      'run',
      COPY_RECIPE,
      '--input',
      join(dir, 'no-existe.json'),
      '--json',
      '-c',
      config,
    ]);

    expect(result.status).toBe(2);
    expect(errorOf(result).code).toBe('E_INPUT');
  });

  it('slot obligatorio faltante → exit 2 / E_INPUT mencionando el slot', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const input = writeJson(dir, 'input.json', { brief: 'sólo el brief, falta copy' });

    const result = cli(['run', COPY_RECIPE, '--input', input, '--json', '-c', config]);

    expect(result.status).toBe(2);
    const error = errorOf(result);
    expect(error.code).toBe('E_INPUT');
    expect(error.message).toContain('copy');
  });

  it('fail del motor → exit 1 (noul negative con passAt alto)', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const recipe = writeJson(dir, 'always-fail.json', {
      id: 'always-fail',
      role: 'prueba',
      input: { slots: { texto: { type: 'text', required: true } } },
      criteria: [
        {
          id: 'N1',
          type: 'noul',
          instructions: '¿tiene un problema?',
          polarity: 'negative',
          passAt: 0.99,
          severity: 'blocker',
        },
      ],
      stages: [{ id: 'base', questions: ['N1'] }],
    });

    const result = cli(['run', recipe, '--state', 'texto', '--json', '-c', config]);

    // mock sintetiza noul=0.82 → polarity negative → 0.18 < 0.99
    expect(result.status).toBe(1);
    const out = JSON.parse(result.stdout) as {
      verdict: string;
      criteria: Array<{ normalized: number }>;
    };
    expect(out.verdict).toBe('fail');
    expect(out.criteria[0]?.normalized).toBeCloseTo(0.18, 5);
  });

  it('blocker con confianza baja → exit 3 / needs_review', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const recipe = writeJson(dir, 'review.json', {
      id: 'review',
      role: 'prueba',
      input: { slots: { texto: { type: 'text', required: true } } },
      criteria: [
        {
          id: 'S1',
          type: 'score',
          instructions: '¿qué tan bueno es?',
          criteria: ['malo', 'regular', 'bueno'],
          passAt: 0.1,
          severity: 'blocker',
        },
      ],
      stages: [{ id: 'base', questions: ['S1'] }],
      limits: { minConfidence: 0.9 },
    });

    const result = cli(['run', recipe, '--state', 'texto', '--json', '-c', config]);

    // mock sintetiza score=1 (0.5 normalizado) con confidence 0.66 < 0.9
    expect(result.status).toBe(3);
    const out = JSON.parse(result.stdout) as { verdict: string };
    expect(out.verdict).toBe('needs_review');
  });
});

describe('m1 recipe / doctor', () => {
  it('recipe validate acepta examples/ux-checker.json', () => {
    const result = cli(['recipe', 'validate', UX_RECIPE, '--json']);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { ok: boolean; id: string };
    expect(out.ok).toBe(true);
    expect(out.id).toBe('ux-checker');
  });

  it('recipe schema imprime un JSON Schema con definitions.Recipe', () => {
    const result = cli(['recipe', 'schema', '--json']);

    expect(result.status).toBe(0);
    const schema = JSON.parse(result.stdout) as {
      definitions?: Record<string, { type?: string }>;
    };
    expect(schema.definitions?.Recipe).toBeDefined();
    expect(schema.definitions?.Recipe?.type).toBe('object');
  });

  it('doctor --json con config mock termina en 0 e incluye el alias', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['doctor', '--json', '-c', config], { cwd: dir });

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      ok: boolean;
      providers: Array<{ alias: string; ok: boolean }>;
    };
    expect(out.ok).toBe(true);
    expect(out.providers).toContainEqual(expect.objectContaining({ alias: 'mock', ok: true }));
  });
});
