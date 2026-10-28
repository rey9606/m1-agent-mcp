import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * E2E de `m1 models` / `m1 model *` con tsx. Aísla HOME/USERPROFILE para no
 * tocar las preferencias reales del usuario. Todo usa provider `mock`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let home: string;
const tmpDirs: string[] = [];

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'm1-cli-models-home-'));
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(join(home, '.config', 'm1-agent', 'preferences.json'), { force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-cli-models-'));
  tmpDirs.push(dir);
  return dir;
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, join(REPO, 'src', 'cli', 'index.ts'), ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, NO_COLOR: '1', HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeMockConfig(dir: string): string {
  const path = join(dir, 'm1.config.json');
  writeFileSync(
    path,
    JSON.stringify({ default: 'mock', providers: { mock: { kind: 'mock' } } }, null, 2),
  );
  return path;
}

function errorOf(result: CliResult): { code: string; message: string; hint?: string } {
  const parsed = JSON.parse(result.stderr) as {
    ok: false;
    error: { code: string; message: string; hint?: string };
  };
  return parsed.error;
}

describe('m1 models', () => {
  it('--json devuelve el catálogo del provider mock', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['models', '--json', '-c', config], { cwd: dir });

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      ok: boolean;
      provider: string;
      model: string;
      models: Array<{ id: string; capabilities: { images: boolean } }>;
      warnings: string[];
    };
    expect(out.ok).toBe(true);
    expect(out.provider).toBe('mock');
    expect(out.model).toBe('mock');
    expect(out.models.map((model) => model.id)).toEqual(['mock']);
    expect(out.models[0]?.capabilities.images).toBe(true);
    expect(out.warnings).toEqual([]);
  });

  it('en modo humano muestra la tabla con el modelo efectivo marcado', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['models', '-c', config], { cwd: dir });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('provider: mock');
    expect(result.stdout).toMatch(/\*\s+mock/);
    expect(result.stdout).toContain('vision');
  });
});

describe('m1 model show', () => {
  it('--json incluye modelo efectivo, fuente y capacidades', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['model', 'show', '--json', '-c', config], { cwd: dir });

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      ok: boolean;
      model: string;
      source: string;
      capabilities: { images: boolean };
    };
    expect(out.ok).toBe(true);
    expect(out.model).toBe('mock');
    expect(out.source).toBe('default');
    expect(out.capabilities).toEqual({ images: true });
  });
});

describe('m1 model use', () => {
  it('--project escribe providers.<alias>.model en la config indicada', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['model', 'use', 'mock', '--project', '--json', '-c', config], { cwd: dir });

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as { stored: string; path: string };
    expect(out.stored).toBe('project');
    expect(out.path).toBe(config);

    const onDisk = JSON.parse(readFileSync(config, 'utf8')) as {
      providers: { mock: { model?: string } };
    };
    expect(onDisk.providers.mock.model).toBe('mock');

    const show = cli(['model', 'show', '--json', '-c', config], { cwd: dir });
    expect((JSON.parse(show.stdout) as { source: string }).source).toBe('config');
  });

  it('guarda una preferencia de usuario y `reset` la borra', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const use = cli(['model', 'use', 'mock', '--json', '-c', config], { cwd: dir });
    expect(use.status).toBe(0);
    expect((JSON.parse(use.stdout) as { stored: string }).stored).toBe('preference');

    const show = cli(['model', 'show', '--json', '-c', config], { cwd: dir });
    expect((JSON.parse(show.stdout) as { source: string }).source).toBe('preference');

    const reset = cli(['model', 'reset', '--json', '-c', config], { cwd: dir });
    expect(reset.status).toBe(0);
    expect(JSON.parse(reset.stdout)).toMatchObject({ ok: true, provider: 'mock', removed: true });

    const after = cli(['model', 'show', '--json', '-c', config], { cwd: dir });
    expect((JSON.parse(after.stdout) as { source: string }).source).toBe('default');
  });

  it('rechaza un modelo inválido con exit 2 / E_USAGE y lista los válidos', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['model', 'use', 'modelo-invalido', '--json', '-c', config], { cwd: dir });

    expect(result.status).toBe(2);
    const error = errorOf(result);
    expect(error.code).toBe('E_USAGE');
    expect(error.hint).toContain('mock');
  });

  it('--project sin config existente falla con E_CONFIG', () => {
    const dir = makeTmp();

    const result = cli(['model', 'use', 'mock', '--project', '--json', '-c', join(dir, 'nope.json')], {
      cwd: dir,
    });

    expect(result.status).toBe(2);
    expect(errorOf(result).code).toBe('E_CONFIG');
  });
});

describe('precedencia del modelo en m1 run', () => {
  it('--model gana sobre la preferencia y no la modifica', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const recipe = join(dir, 'simple.json');
    writeFileSync(
      recipe,
      JSON.stringify({
        id: 'simple',
        role: 'tester',
        input: { slots: { state: { type: 'text', required: true } } },
        criteria: [{ id: 'a', type: 'noul', instructions: '¿A?' }],
        stages: [{ id: 's1', questions: ['a'] }],
      }),
    );

    // Preferencia: mock. Luego el flag debe ganar sin pisar la preferencia.
    expect(cli(['model', 'use', 'mock', '--json', '-c', config], { cwd: dir }).status).toBe(0);

    const withPreference = cli(['run', recipe, '--state', 'texto', '--json', '-c', config], {
      cwd: dir,
    });
    expect(withPreference.status).toBe(0);
    expect((JSON.parse(withPreference.stdout) as { meta: { model: string } }).meta.model).toBe('mock');

    const withFlag = cli(
      ['run', recipe, '--state', 'texto', '--model', 'otro-modelo', '--json', '-c', config],
      { cwd: dir },
    );
    expect(withFlag.status).toBe(0);
    expect((JSON.parse(withFlag.stdout) as { meta: { model: string } }).meta.model).toBe('otro-modelo');

    const show = cli(['model', 'show', '--json', '-c', config], { cwd: dir });
    expect(JSON.parse(show.stdout)).toMatchObject({ model: 'mock', source: 'preference' });
  });
});
