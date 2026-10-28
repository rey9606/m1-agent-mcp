import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { M1Error } from '../src/core/errors.js';
import { findConfigPath, loadConfig, parseConfig, resolveProvider } from '../src/config/config.js';
import type { AppConfig } from '../src/config/config.js';
import type { ProviderConfig } from '../src/providers/types.js';

/** Ejecuta `fn` y devuelve el M1Error lanzado (falla si no lanza). */
function catchM1(fn: () => unknown): M1Error {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(M1Error);
    return error as M1Error;
  }
  throw new Error('se esperaba un M1Error');
}

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  TEST_CF_KEY: process.env.TEST_CF_KEY,
};

let home: string;
let credentials: typeof import('../src/config/credentials.js');
const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-config-'));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, value: unknown = { default: 'mock', providers: { mock: { kind: 'mock' } } }): string {
  const path = join(dir, 'm1.config.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'm1-home-'));
  // `homedir()` se resuelve en cada llamada, así que alcanza con aislar el env
  // antes de importar el módulo de credenciales.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.TEST_CF_KEY;
  credentials = await import('../src/config/credentials.js');
});

beforeEach(() => {
  rmSync(credentials.credentialsPath(), { force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('parseConfig', () => {
  it('acepta una config válida y conserva el source', () => {
    const config = parseConfig(
      { default: 'mock', providers: { mock: { kind: 'mock' } } },
      '/tmp/m1.config.json',
    );

    expect(config.defaultProvider).toBe('mock');
    expect(config.providers.mock).toEqual({ kind: 'mock' });
    expect(config.source).toBe('/tmp/m1.config.json');
  });

  it('respeta el default explícito', () => {
    const config = parseConfig({
      default: 'zz',
      providers: { cf: { kind: 'mock' }, zz: { kind: 'mock' } },
    });

    expect(config.defaultProvider).toBe('zz');
  });

  it("deriva el default 'cf' cuando existe y no hay default explícito", () => {
    const config = parseConfig({
      providers: { zz: { kind: 'mock' }, cf: { kind: 'mock' } },
    });

    expect(config.defaultProvider).toBe('cf');
  });

  it('sin default ni cf usa el primer alias', () => {
    const config = parseConfig({ providers: { primero: { kind: 'mock' }, segundo: { kind: 'mock' } } });
    expect(config.defaultProvider).toBe('primero');
  });

  it('falla si el default no existe, listando los disponibles', () => {
    const error = catchM1(() =>
      parseConfig({ default: 'nope', providers: { mock: { kind: 'mock' } } }),
    );

    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('nope');
    expect(error.hint).toContain('mock');
  });

  it('falla con kind inválido y sugiere los kinds válidos', () => {
    const error = catchM1(() =>
      parseConfig({ providers: { x: { kind: 'inexistente' } } }),
    );

    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('inexistente');
    expect(error.hint).toContain('cloudflare, typesafe, systemone, mock');
  });

  it('falla si providers está vacío', () => {
    const error = catchM1(() => parseConfig({ providers: {} }));
    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('no hay providers');
  });

  it('falla con systemone sin baseUrl', () => {
    const error = catchM1(() =>
      parseConfig({ providers: { local: { kind: 'systemone' } } }),
    );

    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('baseUrl');
  });

  it('falla si la config no es un objeto', () => {
    const error = catchM1(() => parseConfig(null));
    expect(error.code).toBe('E_CONFIG');
  });
});

describe('findConfigPath', () => {
  it('falla con E_CONFIG si la ruta explícita no existe', () => {
    const dir = makeTmp();
    const error = catchM1(() => findConfigPath(join(dir, 'missing.json'), dir));

    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('missing.json');
  });

  it('devuelve la ruta absoluta de una config explícita válida', () => {
    const dir = makeTmp();
    writeConfig(dir);

    expect(findConfigPath('m1.config.json', dir)).toBe(resolve(dir, 'm1.config.json'));
  });

  it('hace fallback a cwd/m1.config.json', () => {
    const dir = makeTmp();
    const path = writeConfig(dir);

    expect(findConfigPath(undefined, dir)).toBe(path);
  });

  it('devuelve undefined si no hay config en cwd ni en el home', () => {
    const dir = makeTmp();
    expect(findConfigPath(undefined, dir)).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('sin archivos de config devuelve un provider mock builtin', () => {
    const dir = makeTmp();
    const config = loadConfig({ cwd: dir });

    expect(config.defaultProvider).toBe('mock');
    expect(config.providers.mock).toEqual({ kind: 'mock' });
    expect(config.source).toBe('(builtin)');
  });

  it('carga una config explícita y registra el source', () => {
    const dir = makeTmp();
    const path = writeConfig(dir);

    const config = loadConfig({ explicit: path, cwd: dir });

    expect(config.defaultProvider).toBe('mock');
    expect(config.source).toBe(path);
  });
});

describe('resolveProvider', () => {
  const config: AppConfig = {
    defaultProvider: 'mock',
    providers: { mock: { kind: 'mock', model: 'm1', timeoutMs: 1000 } },
  };

  it('falla con E_CONFIG y lista los alias disponibles', () => {
    const error = catchM1(() => resolveProvider(config, 'nope'));

    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('nope');
    expect(error.hint).toContain('mock');
  });

  it('aplica overrides de model y timeout sin mutar la config', () => {
    const { alias, config: resolved } = resolveProvider(config, 'mock', {
      model: 'm2',
      timeoutMs: 4242,
    });

    expect(alias).toBe('mock');
    expect(resolved.model).toBe('m2');
    expect(resolved.timeoutMs).toBe(4242);
    expect(config.providers.mock?.model).toBe('m1');
  });

  it('usa el defaultProvider cuando no se pasa alias', () => {
    const { alias } = resolveProvider({ defaultProvider: 'x', providers: { x: { kind: 'mock' } } });
    expect(alias).toBe('x');
  });
});

describe('credenciales', () => {
  it('guarda, carga, actualiza y borra credenciales en el home aislado', () => {
    const path = credentials.credentialsPath();
    expect(path.startsWith(home)).toBe(true);
    expect(credentials.loadCredentials()).toEqual({});

    credentials.saveCredential('cf', { apiKey: 'key-1', accountId: 'acc-1' });

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual({ cf: { apiKey: 'key-1', accountId: 'acc-1' } });

    credentials.saveCredential('cf', { apiKey: 'key-2' });
    expect(credentials.loadCredentials().cf).toEqual({ apiKey: 'key-2', accountId: 'acc-1' });

    expect(credentials.deleteCredential('cf')).toBe(true);
    expect(credentials.loadCredentials()).toEqual({});
    expect(credentials.deleteCredential('cf')).toBe(false);
  });
});

describe('resolveSecrets', () => {
  const cfg = (value: Partial<ProviderConfig>): ProviderConfig =>
    ({ kind: 'cloudflare', ...value }) as ProviderConfig;

  it('prioriza config.apiKey > env > credentials.json y accountId por env', () => {
    credentials.saveCredential('cf', { apiKey: 'cred-key', accountId: 'cred-acc' });
    vi.stubEnv('TEST_CF_KEY', 'env-key');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'env-acc');

    // 1. config explícita gana sobre env y credenciales.
    expect(
      credentials.resolveSecrets('cf', cfg({ apiKey: 'cfg-key', apiKeyEnv: 'TEST_CF_KEY', accountId: 'cfg-acc' })),
    ).toEqual({ apiKey: 'cfg-key', accountId: 'cfg-acc' });

    // 2. env gana sobre credentials.json.
    expect(credentials.resolveSecrets('cf', cfg({ apiKeyEnv: 'TEST_CF_KEY' }))).toEqual({
      apiKey: 'env-key',
      accountId: 'env-acc',
    });
  });

  it('CLOUDFLARE_API_TOKEN por defecto para kind cloudflare', () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'env-token');

    expect(credentials.resolveSecrets('cf', cfg({}))).toEqual({
      apiKey: 'env-token',
      accountId: undefined,
    });
    expect(credentials.resolveSecrets('ts', cfg({ kind: 'typesafe' })).apiKey).toBeUndefined();
  });

  it('CLOUDFLARE_ACCOUNT_ID sólo aplica a kind cloudflare', () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'env-acc');

    expect(credentials.resolveSecrets('ts', cfg({ kind: 'typesafe' })).accountId).toBeUndefined();
    expect(credentials.resolveSecrets('cf', cfg({})).accountId).toBe('env-acc');
  });

  it('usa el apiKeyEnv guardado por auth set --env', () => {
    credentials.saveCredential('cf', { apiKeyEnv: 'TEST_CF_KEY' });
    vi.stubEnv('TEST_CF_KEY', 'env-key');

    expect(credentials.resolveSecrets('cf', cfg({}))).toEqual({
      apiKey: 'env-key',
      accountId: undefined,
    });
  });

  it('ignora variables de entorno vacías (no pisan credentials.json)', () => {
    credentials.saveCredential('cf', { apiKey: 'cred-key', accountId: 'cred-acc' });
    vi.stubEnv('TEST_CF_KEY', '');
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');

    expect(
      credentials.resolveSecrets('cf', cfg({ apiKeyEnv: 'TEST_CF_KEY' })),
    ).toEqual({ apiKey: 'cred-key', accountId: 'cred-acc' });
  });

  it('usa credentials.json cuando no hay config ni env', () => {
    credentials.saveCredential('cf', { apiKey: 'cred-key', accountId: 'cred-acc' });

    expect(credentials.resolveSecrets('cf', cfg({}))).toEqual({
      apiKey: 'cred-key',
      accountId: 'cred-acc',
    });
  });

  it('devuelve undefined cuando no hay ninguna fuente', () => {
    expect(credentials.resolveSecrets('cf', cfg({}))).toEqual({
      apiKey: undefined,
      accountId: undefined,
    });
  });
});

describe('redact', () => {
  it('no expone el secreto completo', () => {
    const secret = 'sk-abcdef1234567890';
    const redacted = credentials.redact(secret);

    expect(redacted).not.toContain(secret);
    expect(redacted).toContain('…');
    expect(redacted).toMatch(/^sk-…/);
  });

  it('oculta por completo los valores muy cortos', () => {
    expect(credentials.redact('abc')).toBe('***');
    expect(credentials.redact('abcdef')).toBe('***');
  });

  it('indica cuando no hay valor', () => {
    expect(credentials.redact(undefined)).toBe('(sin definir)');
  });
});
