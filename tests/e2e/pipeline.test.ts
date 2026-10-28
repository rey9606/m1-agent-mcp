import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Pipelines E2E del motor a través de la CLI (tsx). Cubre `when` encadenados,
 * `derived` + `acceptance`, slots `json`, y errores de provider/tiempo contra
 * servidores HTTP locales. Nunca se toca la red: 127.0.0.1 únicamente.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const tmpDirs: string[] = [];
const servers: Server[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-e2e-pipeline-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJson(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/** Config con un provider mock (sin fixtures: el mock sintetiza respuestas). */
function writeMockConfig(dir: string): string {
  return writeJson(dir, 'm1.config.json', {
    default: 'mock',
    providers: { mock: { kind: 'mock' } },
  });
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], opts: { cwd?: string } = {}): Promise<CliResult> {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI, ...args], {
      cwd: opts.cwd ?? REPO,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', rejectCli);
    child.on('close', (status) => resolveCli({ status, stdout, stderr }));
  });
}

function cliSync(args: string[], opts: { cwd?: string } = {}): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
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

function errorOf(result: CliResult): { code: string; message: string; hint?: string } {
  const parsed = JSON.parse(result.stderr) as {
    ok: false;
    error: { code: string; message: string; hint?: string };
  };
  return parsed.error;
}

/** Servidor local que se registra para cerrarse en `afterAll`. */
function trackedServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server {
  const server = createServer(handler);
  servers.push(server);
  return server;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  return (server.address() as AddressInfo).port;
}

const BASE_RECIPE = {
  schema: 'm1agent/recipe@1',
  role: 'tester de pipelines',
  input: { slots: { state: { type: 'text', required: true } } },
};

afterAll(async () => {
  for (const server of servers.splice(0)) {
    const withCloseAll = server as Server & { closeAllConnections?: () => void };
    withCloseAll.closeAllConnections?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('pipelines del motor', () => {
  it('encadena `when`: s1 y s2 corren, s3 se saltea', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const recipe = writeJson(dir, 'chain.json', {
      ...BASE_RECIPE,
      id: 'chain',
      criteria: [
        { id: 'A', type: 'noul', instructions: '¿A?', passAt: 0.5 },
        { id: 'B', type: 'noul', instructions: '¿B?', passAt: 0.5 },
        { id: 'C', type: 'noul', instructions: '¿C?', passAt: 0.5 },
      ],
      stages: [
        { id: 's1', questions: ['A'] },
        { id: 's2', when: 'A >= 0.5', questions: ['B'] },
        { id: 's3', when: 'B < 0.5', questions: ['C'] },
      ],
    });

    const result = cliSync(['run', recipe, '--state', 'texto', '--json', '-c', config]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      verdict: string;
      meta: { calls: number };
      trace: Array<{ id: string; status: string; reason?: string; questions: string[] }>;
    };
    // mock sintetiza noul=0.82: A>=0.5 => B corre; B<0.5 es falso => C se saltea.
    expect(out.meta.calls).toBe(2);
    expect(out.trace.map((t) => [t.id, t.status])).toEqual([
      ['s1', 'ran'],
      ['s2', 'ran'],
      ['s3', 'skipped'],
    ]);
    expect(out.trace[2]?.reason).toBe('when=false');
    expect(out.trace[2]?.questions).toEqual(['C']);
    expect(out.verdict).toBe('pass');
  });

  it('evalúa `derived` y `acceptance` que referencia el derived', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const recipe = writeJson(dir, 'derived.json', {
      ...BASE_RECIPE,
      id: 'derived',
      criteria: [{ id: 'A', type: 'noul', instructions: '¿A?', passAt: 0.5 }],
      stages: [{ id: 's1', questions: ['A'] }],
      derived: [{ id: 'double', expr: 'A * 2', description: 'doble del valor normalizado' }],
      acceptance: [{ id: 'AC1', expr: 'double >= 1.5', severity: 'blocker' }],
    });

    const result = cliSync(['run', recipe, '--state', 'texto', '--json', '-c', config]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      verdict: string;
      derived: Record<string, number>;
      acceptance: Array<{ id: string; expr: string; passed: boolean }>;
    };
    expect(out.derived.double).toBeCloseTo(1.64, 5);
    expect(out.acceptance).toEqual([
      expect.objectContaining({ id: 'AC1', expr: 'double >= 1.5', passed: true }),
    ]);
    expect(out.verdict).toBe('pass');
  });

  it('renderiza un slot `json` con {{objeto.campo}} en el state del request', () => {
    const dir = makeTmp();
    const config = writeMockConfig(dir);
    const recipe = writeJson(dir, 'json-slot.json', {
      id: 'json-slot',
      role: 'tester de slots json',
      input: { slots: { objeto: { type: 'json', required: true } } },
      criteria: [{ id: 'A', type: 'noul', instructions: '¿A?', passAt: 0.5 }],
      stages: [
        {
          id: 's1',
          questions: ['A'],
          state: { campo: '{{objeto.campo}}', numero: '{{objeto.numero}}' },
        },
      ],
    });
    const input = writeJson(dir, 'input.json', { objeto: { campo: 'valor-x', numero: 7 } });

    const result = cliSync([
      'run',
      recipe,
      '--input',
      input,
      '--print-request',
      '-c',
      config,
    ]);

    expect(result.status).toBe(0);
    const out = JSON.parse(result.stdout) as {
      ok: boolean;
      requests: Array<{ state: unknown }>;
    };
    expect(out.ok).toBe(true);
    expect(out.requests[0]?.state).toEqual({ campo: 'valor-x', numero: 7 });
  });

  it('un HTTP 500 del provider produce exit 2 / E_PROVIDER', async () => {
    const dir = makeTmp();
    const recipe = writeJson(dir, 'http-error.json', {
      ...BASE_RECIPE,
      id: 'http-error',
      criteria: [{ id: 'A', type: 'noul', instructions: '¿A?', passAt: 0.5 }],
      stages: [{ id: 's1', questions: ['A'] }],
    });

    const server = trackedServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('fallo simulado');
    });
    const port = await listen(server);
    const config = writeJson(dir, 'm1.config.json', {
      default: 'local',
      providers: {
        local: { kind: 'systemone', baseUrl: `http://127.0.0.1:${port}/v1/systemone`, timeoutMs: 5000 },
      },
    });

    const result = await cli(['run', recipe, '--state', 'texto', '--json', '-c', config]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    const error = errorOf(result);
    expect(error.code).toBe('E_PROVIDER');
    expect(error.message).toContain('500');
  }, 30_000);

  it('un provider que nunca responde produce exit 2 / E_TIMEOUT con --timeout 300', async () => {
    const dir = makeTmp();
    const recipe = writeJson(dir, 'timeout.json', {
      ...BASE_RECIPE,
      id: 'timeout',
      criteria: [{ id: 'A', type: 'noul', instructions: '¿A?', passAt: 0.5 }],
      stages: [{ id: 's1', questions: ['A'] }],
    });

    // Nunca escribe respuesta: deja la conexión colgada hasta el abort.
    const server = trackedServer(() => {});
    const port = await listen(server);
    const config = writeJson(dir, 'm1.config.json', {
      default: 'local',
      providers: {
        local: { kind: 'systemone', baseUrl: `http://127.0.0.1:${port}/v1/systemone`, timeoutMs: 30_000 },
      },
    });

    const result = await cli([
      'run',
      recipe,
      '--state',
      'texto',
      '--json',
      '--timeout',
      '300',
      '-c',
      config,
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(errorOf(result).code).toBe('E_TIMEOUT');
  }, 30_000);
});
