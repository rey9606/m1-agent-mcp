import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

/**
 * Tests de la capa "agent-friendly": guía, ayuda sin argumentos, errores de
 * uso (E_USAGE) con sugerencia y hints contextuales de `local`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
/** Cache aislado: evita leer el registro real de ~/.cache/m1-agent. */
const CACHE_DIR = mkdtempSync(join(tmpdir(), 'm1-agent-cache-'));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, join(REPO, 'src', 'cli', 'index.ts'), ...args], {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, NO_COLOR: '1', M1_CACHE_DIR: CACHE_DIR },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-agent-'));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, value: unknown): string {
  const path = join(dir, 'm1.config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

describe('m1 guide', () => {
  it('imprime el tutorial en texto y sale con 0', () => {
    const result = cli(['guide']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('m1 v0.1.0');
    expect(result.stdout).toContain('## Comandos');
    expect(result.stdout).toContain('## Exit codes');
    expect(result.stdout).toContain('## Reglas para agentes');
    expect(result.stdout).toContain('m1 run examples/copy-checker.json');
  });

  it('--json devuelve secciones estructuradas y la versión', () => {
    const result = cli(['guide', '--json']);

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      version: string;
      sections: Array<{ id: string; title: string; body: string }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.version).toBe('0.1.0');
    const ids = payload.sections.map((section) => section.id);
    expect(ids).toContain('que-es');
    expect(ids).toContain('salida');
    expect(ids).toContain('exit-codes');
    expect(ids).toContain('errores');
    expect(ids).toContain('agentes');
    for (const section of payload.sections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.body.length).toBeGreaterThan(0);
    }
  });
});

describe('ayuda y errores de uso', () => {
  it('sin argumentos muestra la ayuda completa y sale con 0', () => {
    const result = cli([]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: m1');
    expect(result.stdout).toContain('Ejemplos:');
    expect(result.stdout).toContain('m1 guide');
    expect(result.stdout).toContain('Exit codes: 0 pass');
  });

  it('flag desconocido sugiere el más parecido y sale con 2 / E_USAGE', () => {
    const result = cli(['run', 'x.json', '--jsn']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain("unknown option '--jsn'");
    expect(result.stderr).toContain('Did you mean --json?');
    expect(result.stderr).toContain('m1 guide');
  });

  it('flag desconocido con --json devuelve JSON con docs de recuperación', () => {
    const result = cli(['run', 'x.json', '--jsn', '--json']);

    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string; message: string; hint: string };
      docs: { guide: string; help: string; exitCodes: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('E_USAGE');
    expect(payload.error.hint).toContain('m1 guide');
    expect(payload.docs.guide).toBe('m1 guide --json');
    expect(payload.docs.help).toBe('m1 <comando> --help');
    expect(payload.docs.exitCodes).toContain('needs_review');
  });

  it('comando desconocido sugiere el correcto', () => {
    const result = cli(['ru']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('E_USAGE');
    expect(result.stderr).toContain("unknown command 'ru'");
    expect(result.stderr).toContain('Did you mean run?');
  });
});

describe('hints de m1 local', () => {
  const configWithLocal = () => ({
    default: 'cf',
    providers: {
      cf: { kind: 'cloudflare' },
      liquid: {
        kind: 'systemone',
        baseUrl: 'http://127.0.0.1:59987/v1/systemone',
        launch: { command: 'llama-server', args: ['-hf', 'repo:Q8_0'], port: 59987 },
      },
    },
  });

  it('con provider no local indica el alias y el comando exacto', () => {
    const dir = makeTmp();
    const config = writeConfig(dir, configWithLocal());

    const result = cli(['local', 'status', '--provider', 'cf', '-c', config]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('E_CONFIG');
    expect(result.stderr).toContain('m1 local status --provider liquid');
  });

  it('sin --provider y con un único local lo usa y lo avisa', () => {
    const dir = makeTmp();
    const config = writeConfig(dir, configWithLocal());

    const result = cli(['local', 'status', '-c', config]);

    expect(result.status).toBe(2); // está down, pero eligió el alias correcto
    expect(result.stderr).toContain('único provider local');
    expect(result.stdout).toContain('liquid');
    expect(result.stdout).toContain('m1 local start --provider liquid');
  });

  it('sin providers locales explica cómo agregarlos', () => {
    const dir = makeTmp();
    const config = writeConfig(dir, { default: 'mock', providers: { mock: { kind: 'mock' } } });

    const result = cli(['local', 'status', '-c', config]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no hay providers locales');
    expect(result.stderr).toContain('Modelo local');
  });
});