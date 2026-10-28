import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * E2E del binario COMPILADO: todos los casos ejecutan `dist/cli/index.js`
 * con `node`, no `tsx`. El build se hace una sola vez en `beforeAll`.
 * Nunca se toca la red: la config usa provider `mock`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const DIST_CLI = join(REPO, 'dist', 'cli', 'index.js');
const COPY_RECIPE = join(REPO, 'examples', 'copy-checker.json');
const UX_RECIPE = join(REPO, 'examples', 'ux-checker.json');
const MOCK_FIXTURES = join(REPO, 'fixtures', 'mock');

/** PNG 1x1 válido (magic bytes + IHDR + IEND). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Directorios temporales creados por los tests; se limpian en `afterAll`. */
const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-e2e-dist-'));
  tmpDirs.push(dir);
  return dir;
}

/** Ejecuta `pnpm build` sin `shell:true`; en Windows usa cmd.exe /c. */
function build(): void {
  const env = { ...process.env, NO_COLOR: '1' };
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? 'cmd.exe';
    execFileSync(comspec, ['/d', '/s', '/c', 'pnpm build'], {
      cwd: REPO,
      env,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return;
  }
  execFileSync('pnpm', ['build'], { cwd: REPO, env, stdio: 'pipe', encoding: 'utf8' });
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** Config con un único provider `mock` apuntando a los fixtures del repo. */
function writeMockConfig(dir: string, withFixtures = true): string {
  const provider: Record<string, unknown> = { kind: 'mock' };
  if (withFixtures) provider.fixturesDir = MOCK_FIXTURES;
  const path = join(dir, 'm1.config.json');
  writeFileSync(path, JSON.stringify({ default: 'mock', providers: { mock: provider } }));
  return path;
}

beforeAll(() => {
  build();
  expect(existsSync(DIST_CLI)).toBe(true);
}, 120_000);

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('binario compilado (dist/cli/index.js)', () => {
  it('genera dist/cli/index.js al compilar', () => {
    expect(existsSync(DIST_CLI)).toBe(true);
  });

  it('--help lista run, recipe, auth y doctor', () => {
    const result = cli(['--help']);

    expect(result.status).toBe(0);
    for (const command of ['run', 'recipe', 'auth', 'doctor']) {
      expect(result.stdout).toContain(command);
    }
  });

  it('corre copy-checker con provider mock y devuelve verdict pass', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);

    const result = cli(['run', COPY_RECIPE, '--provider', 'mock', '--state', 'texto', '--json', '-c', config]);

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

  it('recipe schema --json incluye definitions.Recipe', () => {
    const result = cli(['recipe', 'schema', '--json']);

    expect(result.status).toBe(0);
    const schema = JSON.parse(result.stdout) as {
      definitions?: Record<string, { type?: string }>;
    };
    expect(schema.definitions?.Recipe).toBeDefined();
    expect(schema.definitions?.Recipe?.type).toBe('object');
  });

  it('--print-request incluye el modelo y la imagen en base64 con content_type', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir, false);
    const image = join(dir, 'pixel.png');
    writeFileSync(image, PNG_1X1);

    const result = cli(['run', UX_RECIPE, '--image', image, '--print-request', '-c', config]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      ok: boolean;
      requests: Array<{ model?: string; images?: Array<{ content_type: string }> }>;
    };
    expect(out.ok).toBe(true);
    expect(out.requests.length).toBeGreaterThan(0);
    expect(typeof out.requests[0]?.model).toBe('string');
    expect(out.requests[0]?.model?.length).toBeGreaterThan(0);
    expect(out.requests[0]?.images?.[0]?.content_type).toBe('image/png');
  });

  it('dist/cli/index.js conserva el shebang de node', () => {
    const firstLine = readFileSync(DIST_CLI, 'utf8').split('\n', 1)[0];
    expect(firstLine).toBe('#!/usr/bin/env node');
  });
});
