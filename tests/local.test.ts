import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { M1Error } from '../src/core/errors.js';
import {
  buildLaunchSpec,
  ensureLocalEndpoint,
  isLoopbackHost,
  parseLocalEndpoint,
  pickPort,
  probeLocal,
  readLocalRecord,
  stopLocalServer,
  systemoneModelsUrl,
  withPort,
} from '../src/local/lifecycle.js';
import type { LocalRuntime } from '../src/local/lifecycle.js';
import type { ProviderConfig } from '../src/providers/types.js';

const tmpDirs: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-local-'));
  tmpDirs.push(dir);
  return dir;
}

async function listenHttp(handler: Parameters<typeof createHttpServer>[1]): Promise<number> {
  const server = createHttpServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  });
  return (server.address() as AddressInfo).port;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function localCfg(port: number, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    kind: 'systemone',
    baseUrl: `http://127.0.0.1:${port}/v1/systemone`,
    model: 'lfm2-d1',
    launch: {
      command: 'llama-server',
      args: ['-hf', 'LiquidAI/d1-2B-GGUF:Q8_0'],
      port,
    },
    ...overrides,
  };
}

function fakeRuntime(overrides: Partial<LocalRuntime> = {}): LocalRuntime {
  return {
    probe: vi.fn(async () => ({ state: 'down' as const })),
    isPortOpen: vi.fn(async () => false),
    spawnServer: vi.fn(() => ({ pid: 4242, exitCode: null, kill: vi.fn() })),
    confirm: vi.fn(async () => true),
    sleep: vi.fn(async () => undefined),
    now: vi.fn(() => Date.now()),
    isAlive: vi.fn(() => true),
    ...overrides,
  };
}

describe('helpers de endpoint', () => {
  it('detecta hosts loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.10.0.2')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });

  it('deriva puerto, health y catálogo conservando el path', () => {
    expect(parseLocalEndpoint('http://127.0.0.1:9931/v1/systemone')).toEqual({
      origin: 'http://127.0.0.1:9931',
      host: '127.0.0.1',
      port: 9931,
      pathname: '/v1/systemone',
    });
    expect(withPort('http://127.0.0.1:9931/v1/systemone', 9940)).toBe(
      'http://127.0.0.1:9940/v1/systemone',
    );
    expect(systemoneModelsUrl('http://127.0.0.1:9931/v1/systemone')).toBe(
      'http://127.0.0.1:9931/v1/models',
    );
    expect(systemoneModelsUrl('http://127.0.0.1:9931/api/v1/systemone/')).toBe(
      'http://127.0.0.1:9931/api/v1/models',
    );
  });
});

describe('buildLaunchSpec', () => {
  it('reemplaza placeholders y garantiza puerto, host y alias', () => {
    const spec = buildLaunchSpec(
      localCfg(9931, {
        launch: {
          command: 'llama-server',
          args: ['-hf', 'repo:Q8_0', '--port', '{port}', '--host={host}'],
          port: 9931,
        },
      }),
      { port: 9932, host: '127.0.0.1' },
    );

    expect(spec).toEqual({
      command: 'llama-server',
      args: [
        '-hf',
        'repo:Q8_0',
        '--port',
        '9932',
        '--host=127.0.0.1',
        '--alias',
        'lfm2-d1',
      ],
    });
  });

  it('no inyecta flags de llama-server en otros ejecutables', () => {
    const spec = buildLaunchSpec(
      localCfg(9931, {
        launch: { command: 'my-server', args: ['--listen', '{host}:{port}'], port: 9931 },
      }),
      { port: 9999, host: '127.0.0.1' },
    );

    expect(spec.args).toEqual(['--listen', '127.0.0.1:9999']);
  });
});

describe('probeLocal', () => {
  it('running cuando /health responde 2xx y lista los modelos', async () => {
    const port = await listenHttp((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'lfm2-d1' }] }));
        return;
      }
      res.writeHead(404).end();
    });

    const probe = await probeLocal(`http://127.0.0.1:${port}/v1/systemone`);
    expect(probe.state).toBe('running');
    expect(probe.models).toEqual(['lfm2-d1']);
  });

  it('starting cuando /health responde 503', async () => {
    const port = await listenHttp((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"status":"loading model"}');
    });

    const probe = await probeLocal(`http://127.0.0.1:${port}/v1/systemone`);
    expect(probe.state).toBe('starting');
  });

  it('foreign cuando hay otro proceso en el puerto', async () => {
    const port = await listenHttp((_req, res) => {
      res.writeHead(404).end('nope');
    });

    const probe = await probeLocal(`http://127.0.0.1:${port}/v1/systemone`);
    expect(probe.state).toBe('foreign');
  });

  it('down cuando nadie escucha', async () => {
    const port = await freePort();
    const probe = await probeLocal(`http://127.0.0.1:${port}/v1/systemone`);
    expect(probe.state).toBe('down');
  });
});

describe('pickPort', () => {
  it('elige el primer puerto libre desde el preferido', async () => {
    const runtime = fakeRuntime({
      isPortOpen: vi.fn(async (_host: string, port: number) => port === 9931),
    });

    await expect(pickPort('127.0.0.1', 9931, runtime)).resolves.toBe(9932);
  });
});

describe('ensureLocalEndpoint', () => {
  it('usa el servidor que ya está corriendo', async () => {
    const runtime = fakeRuntime({
      probe: vi.fn(async () => ({ state: 'running' as const, models: ['lfm2-d1'] })),
    });

    const result = await ensureLocalEndpoint({
      alias: 'liquid',
      cfg: localCfg(9931),
      interactive: false,
      stateDir: makeStateDir(),
      runtime,
    });

    expect(result.started).toBe(false);
    expect(result.baseUrl).toBe('http://127.0.0.1:9931/v1/systemone');
    expect(runtime.spawnServer).not.toHaveBeenCalled();
  });

  it('no arranca con autoStart=never y explica cómo hacerlo', async () => {
    const cfg = localCfg(9931, {
      launch: { args: ['-hf', 'repo:Q8_0'], port: 9931, autoStart: 'never' },
    });

    const error = await ensureLocalEndpoint({
      alias: 'liquid',
      cfg,
      interactive: true,
      stateDir: makeStateDir(),
      runtime: fakeRuntime(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).code).toBe('E_PROVIDER');
    expect((error as M1Error).hint).toContain('llama-server');
  });

  it('sin TTY no pregunta y falla con la política ask', async () => {
    const runtime = fakeRuntime();
    const error = await ensureLocalEndpoint({
      alias: 'liquid',
      cfg: localCfg(9931),
      interactive: false,
      stateDir: makeStateDir(),
      runtime,
    }).catch((e: unknown) => e);

    expect((error as M1Error).code).toBe('E_PROVIDER');
    expect(runtime.confirm).not.toHaveBeenCalled();
    expect(runtime.spawnServer).not.toHaveBeenCalled();
  });

  it('arranca, espera el health y registra el servidor', async () => {
    const stateDir = makeStateDir();
    let started = false;
    const runtime = fakeRuntime({
      spawnServer: vi.fn(() => {
        started = true;
        return { pid: 4242, exitCode: null, kill: vi.fn() };
      }),
      probe: vi.fn(async (url: string) => {
        if (started && url.includes(':9931')) {
          return { state: 'running' as const, models: ['lfm2-d1'] };
        }
        return { state: 'down' as const };
      }),
    });

    const result = await ensureLocalEndpoint({
      alias: 'liquid',
      cfg: localCfg(9931),
      autoStart: 'always',
      interactive: false,
      stateDir,
      runtime,
    });

    expect(result.started).toBe(true);
    expect(result.baseUrl).toBe('http://127.0.0.1:9931/v1/systemone');
    expect(runtime.confirm).not.toHaveBeenCalled();
    expect(readLocalRecord('liquid', stateDir)?.pid).toBe(4242);
  });

  it('falla si el servidor muere antes de quedar listo', async () => {
    const runtime = fakeRuntime({
      isAlive: vi.fn(() => false),
      probe: vi.fn(async () => ({ state: 'down' as const })),
    });

    const error = await ensureLocalEndpoint({
      alias: 'liquid',
      cfg: localCfg(9931),
      autoStart: 'always',
      interactive: false,
      stateDir: makeStateDir(),
      runtime,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).message).toContain('terminó antes de quedar listo');
    expect(runtime.spawnServer).toHaveBeenCalledOnce();
  });

  it('si el puerto está ocupado por otro proceso usa el siguiente libre', async () => {
    const stateDir = makeStateDir();
    let started = false;
    const runtime = fakeRuntime({
      isPortOpen: vi.fn(async (_host: string, port: number) => port === 9931),
      spawnServer: vi.fn(() => {
        started = true;
        return { pid: 4242, exitCode: null, kill: vi.fn() };
      }),
      probe: vi.fn(async (url: string) => {
        if (started && url.includes(':9932')) {
          return { state: 'running' as const, models: ['lfm2-d1'] };
        }
        return { state: 'foreign' as const };
      }),
    });

    const result = await ensureLocalEndpoint({
      alias: 'liquid',
      cfg: localCfg(9931),
      autoStart: 'always',
      interactive: false,
      stateDir,
      runtime,
    });

    expect(result.baseUrl).toBe('http://127.0.0.1:9932/v1/systemone');
    const spec = (runtime.spawnServer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      args: string[];
    };
    expect(spec.args).toContain('9932');
    expect(readLocalRecord('liquid', stateDir)?.port).toBe(9932);
  });

  it('reutiliza un servidor registrado en otro puerto', async () => {
    const stateDir = makeStateDir();
    writeFileSync(
      join(stateDir, 'liquid.json'),
      JSON.stringify({
        pid: 4242,
        port: 9940,
        baseUrl: 'http://127.0.0.1:9940/v1/systemone',
        command: 'llama-server',
        args: [],
        startedAt: new Date().toISOString(),
        logPath: join(stateDir, 'logs', 'liquid.log'),
      }),
    );

    const runtime = fakeRuntime({
      isAlive: vi.fn(() => true),
      probe: vi.fn(async (url: string) =>
        url.includes(':9940')
          ? { state: 'running' as const, models: ['lfm2-d1'] }
          : { state: 'down' as const },
      ),
    });

    const result = await ensureLocalEndpoint({
      alias: 'liquid',
      cfg: localCfg(9931),
      autoStart: 'always',
      interactive: false,
      stateDir,
      runtime,
    });

    expect(result.started).toBe(false);
    expect(result.baseUrl).toBe('http://127.0.0.1:9940/v1/systemone');
    expect(result.warnings[0]).toContain('reutilizando');
    expect(runtime.spawnServer).not.toHaveBeenCalled();
  });
});

describe('stopLocalServer', () => {
  it('sin registro no hace nada', () => {
    expect(stopLocalServer('liquid', makeStateDir())).toEqual({
      stopped: false,
      reason: 'no hay un servidor local registrado',
    });
  });

  it('limpia un registro con pid muerto', () => {
    const stateDir = makeStateDir();
    writeFileSync(
      join(stateDir, 'liquid.json'),
      JSON.stringify({
        pid: 999_999,
        port: 9931,
        baseUrl: 'http://127.0.0.1:9931/v1/systemone',
        command: 'llama-server',
        args: [],
        startedAt: new Date().toISOString(),
        logPath: 'x',
      }),
    );

    const result = stopLocalServer('liquid', stateDir);
    expect(result.stopped).toBe(false);
    expect(result.reason).toContain('ya no está corriendo');
    expect(readLocalRecord('liquid', stateDir)).toBeUndefined();
  });
});
