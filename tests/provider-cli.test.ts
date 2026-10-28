import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { M1Error } from '../src/core/errors.js';
import { parseConfig } from '../src/config/config.js';
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
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  OPENROUTER_KEY: process.env.OPENROUTER_KEY,
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  M1_API_KEY: process.env.M1_API_KEY,
};

const PROVIDER_ENV_VARS = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'OPENROUTER_KEY',
  'TYPESAFE_API_KEY',
  'M1_API_KEY',
] as const;

let home: string;
let store: typeof import('../src/config/providerStore.js');
let credentials: typeof import('../src/config/credentials.js');

interface ConfigFile {
  default?: string;
  providers: Record<string, ProviderConfig>;
}

function readConfig(): ConfigFile {
  return JSON.parse(readFileSync(store.globalConfigPath(), 'utf8')) as ConfigFile;
}

function readCredentialsFile(): Record<string, { apiKey?: string }> {
  return JSON.parse(readFileSync(credentials.credentialsPath(), 'utf8')) as Record<
    string,
    { apiKey?: string }
  >;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'm1-provider-home-'));
  // `homedir()` se resuelve en cada llamada: alcanza con aislar el env antes
  // de importar los módulos que escriben en el home.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of PROVIDER_ENV_VARS) delete process.env[key];
  store = await import('../src/config/providerStore.js');
  credentials = await import('../src/config/credentials.js');
});

beforeEach(() => {
  rmSync(store.globalConfigPath(), { force: true });
  rmSync(credentials.credentialsPath(), { force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('globalConfigPath / loadGlobalConfig', () => {
  it('usa ~/.config/m1-agent/config.json', () => {
    expect(store.globalConfigPath()).toBe(join(home, '.config', 'm1-agent', 'config.json'));
  });

  it('sin archivo devuelve una base vacía con providers {}', () => {
    const loaded = store.loadGlobalConfig();
    expect(loaded.exists).toBe(false);
    expect(loaded.raw).toEqual({ providers: {} });
  });

  it('escribe JSON con 2 espacios y salto final', () => {
    store.addProvider('local', { preset: 'llamacpp' });
    const text = readFileSync(store.globalConfigPath(), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "providers"');
    expect(text).not.toContain('\t');
  });
});

describe('addProvider: presets', () => {
  it('el preset llamacpp crea systemone + launch, sin modelo, y queda como default', () => {
    const result = store.addProvider('llamacpp', { preset: 'llamacpp' });

    expect(result.config.kind).toBe('systemone');
    expect(result.config.model).toBeUndefined();
    expect(result.config.baseUrl).toBe('http://127.0.0.1:9931/v1/systemone');
    expect(result.config.launch).toMatchObject({
      command: 'llama-server',
      args: [],
      port: 9931,
      startTimeoutMs: 120_000,
      autoStart: 'always',
      console: true,
    });
    expect(result.defaultProvider).toBe('llamacpp');

    const onDisk = readConfig();
    expect(onDisk.default).toBe('llamacpp');
    expect(onDisk.providers.llamacpp?.model).toBeUndefined();
    expect(onDisk.providers.llamacpp?.launch?.args).toEqual([]);
    // La config escrita tiene que seguir siendo válida para parseConfig.
    expect(() => parseConfig(onDisk)).not.toThrow();
  });

  it('el preset custom exige baseUrl y no escribe nada si falta', () => {
    const error = catchM1(() => store.addProvider('mio', { preset: 'custom' }));

    expect(error.code).toBe('E_INPUT');
    expect(error.message).toContain('baseUrl');
    expect(existsSync(store.globalConfigPath())).toBe(false);
  });

  it('el preset custom con baseUrl guarda el modelo sugerido y sin launch', () => {
    const result = store.addProvider('mio', {
      preset: 'custom',
      baseUrl: 'http://127.0.0.1:8080/v1/systemone',
    });

    expect(result.config).toMatchObject({
      kind: 'systemone',
      model: 'local-decision',
      baseUrl: 'http://127.0.0.1:8080/v1/systemone',
      apiKeyEnv: 'M1_API_KEY',
    });
    expect(result.config.launch).toBeUndefined();
  });

  it('--kind systemone sin preset también exige baseUrl', () => {
    const error = catchM1(() => store.addProvider('local', { kind: 'systemone' }));
    expect(error.code).toBe('E_INPUT');
    expect(error.message).toContain('baseUrl');
  });

  it('rechaza un kind inexistente con los kinds válidos en el hint', () => {
    const error = catchM1(() => store.addProvider('raro', { kind: 'foo' }));
    expect(error.code).toBe('E_USAGE');
    expect(error.hint).toContain('cloudflare');
  });

  it('rechaza un preset inexistente listando los disponibles', () => {
    const error = catchM1(() => store.addProvider('raro', { preset: 'nope' }));
    expect(error.code).toBe('E_USAGE');
    expect(error.hint).toContain('llamacpp');
  });
});

describe('addProvider: cloudflare', () => {
  it('exige account id y no guarda nada si falta', () => {
    const error = catchM1(() => store.addProvider('cf', { preset: 'cloudflare', apiKey: 'tok-123' }));

    expect(error.code).toBe('E_INPUT');
    expect(error.message).toContain('account id');
    expect(existsSync(store.globalConfigPath())).toBe(false);
    expect(credentials.loadCredentials()).toEqual({});
  });

  it('acepta el account id desde el entorno', () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'acc-env');

    const result = store.addProvider('cf', { preset: 'cloudflare' });

    expect(result.config.accountId).toBeUndefined();
    expect(store.describeProvider('cf', result.config).hasAccountId).toBe(true);
  });

  it('persiste --account-id en la config', () => {
    store.addProvider('cf', { preset: 'cloudflare', accountId: 'acc-1' });
    expect(readConfig().providers.cf?.accountId).toBe('acc-1');
  });
});

describe('addProvider: secretos', () => {
  it('guarda la api key en credentials.json y NO en la config', () => {
    store.addProvider('ts', { preset: 'typesafe', apiKey: 'sk-secret-123' });

    const configText = readFileSync(store.globalConfigPath(), 'utf8');
    expect(configText).not.toContain('sk-secret-123');
    expect(configText).not.toContain('"apiKey"');

    expect(readCredentialsFile().ts).toEqual({ apiKey: 'sk-secret-123' });
    expect(store.describeProvider('ts', store.getProvider('ts')).keySource).toBe('credentials');
  });

  it('aplica el apiKeyEnv del preset cloudflare', () => {
    store.addProvider('cf', { preset: 'cloudflare', accountId: 'acc-1' });
    expect(readConfig().providers.cf?.apiKeyEnv).toBe('CLOUDFLARE_API_TOKEN');
  });
});

describe('addProvider: aliases', () => {
  it('rechaza aliases inválidos', () => {
    for (const alias of ['Mío', 'con espacios', '-inicio', '']) {
      const error = catchM1(() => store.addProvider(alias, { preset: 'llamacpp' }));
      expect(error.code).toBe('E_USAGE');
      expect(error.message).toContain('alias inválido');
    }
  });

  it('rechaza un alias existente con E_USAGE', () => {
    store.addProvider('local', { preset: 'llamacpp' });
    const error = catchM1(() => store.addProvider('local', { preset: 'llamacpp' }));

    expect(error.code).toBe('E_USAGE');
    expect(error.hint).toContain('edit');
  });

  it('respeta --default explícito', () => {
    store.addProvider('a', { preset: 'llamacpp' });
    const result = store.addProvider('b', {
      preset: 'custom',
      baseUrl: 'http://127.0.0.1:8080/v1/systemone',
      default: true,
    });

    expect(result.defaultProvider).toBe('b');
    expect(readConfig().default).toBe('b');
  });
});

describe('editProvider', () => {
  it('cambia sólo los campos provistos', () => {
    store.addProvider('local', { preset: 'llamacpp' });

    store.editProvider('local', { model: 'lfm2-d1', apiKeyEnv: 'M1_TOKEN' });

    const cfg = store.getProvider('local');
    expect(cfg.model).toBe('lfm2-d1');
    expect(cfg.apiKeyEnv).toBe('M1_TOKEN');
    expect(cfg.launch?.port).toBe(9931);
    expect(cfg.baseUrl).toBe('http://127.0.0.1:9931/v1/systemone');
  });

  it('manda --api-key a credentials y --clear-api-key la borra', () => {
    store.addProvider('local', { preset: 'llamacpp' });

    store.editProvider('local', { apiKey: 'key-2' });
    expect(readCredentialsFile().local).toEqual({ apiKey: 'key-2' });
    expect(readFileSync(store.globalConfigPath(), 'utf8')).not.toContain('key-2');

    const cleared = store.editProvider('local', { clearApiKey: true });
    expect(cleared.changed).toContain('apiKey (borrada)');
    expect(credentials.loadCredentials().local).toBeUndefined();
  });

  it('falla sin cambios y con alias inexistente', () => {
    store.addProvider('local', { preset: 'llamacpp' });

    const noChanges = catchM1(() => store.editProvider('local', {}));
    expect(noChanges.code).toBe('E_USAGE');

    const missing = catchM1(() => store.editProvider('nope', { model: 'x' }));
    expect(missing.code).toBe('E_INPUT');
    expect(missing.hint).toContain('m1 provider list');
  });

  it('no deja una config inválida', () => {
    store.addProvider('local', { preset: 'llamacpp' });
    const error = catchM1(() => store.editProvider('local', { baseUrl: '' }));
    expect(error.code).toBe('E_USAGE');
    expect(() => parseConfig(readConfig())).not.toThrow();
  });
});

describe('setDefaultProvider', () => {
  it('mueve el default y valida que el alias exista', () => {
    store.addProvider('a', { preset: 'llamacpp' });
    store.addProvider('b', { preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1/systemone' });
    expect(readConfig().default).toBe('a');

    const result = store.setDefaultProvider('b');
    expect(result.previous).toBe('a');
    expect(readConfig().default).toBe('b');

    const error = catchM1(() => store.setDefaultProvider('nope'));
    expect(error.code).toBe('E_INPUT');
    expect(error.hint).toContain('m1 provider list');
  });
});

describe('removeProvider', () => {
  it('no borra el default si quedan otros providers (sin --force)', () => {
    store.addProvider('a', { preset: 'llamacpp' });
    store.addProvider('b', { preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1/systemone' });

    const error = catchM1(() => store.removeProvider('a'));
    expect(error.code).toBe('E_USAGE');
    expect(error.hint).toContain('--force');
    expect(readConfig().providers.a).toBeDefined();
  });

  it('con --force elige el primer alias restante como default', () => {
    store.addProvider('a', { preset: 'llamacpp' });
    store.addProvider('b', { preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1/systemone' });

    const result = store.removeProvider('a', { force: true });

    expect(result.defaultProvider).toBe('b');
    expect(readConfig().default).toBe('b');
    const missing = catchM1(() => store.getProvider('a'));
    expect(missing.code).toBe('E_INPUT');
  });

  it('borra un no-default sin tocar el default y limpia su credencial', () => {
    store.addProvider('a', { preset: 'llamacpp' });
    store.addProvider('b', { preset: 'typesafe', apiKey: 'sk-1' });

    const result = store.removeProvider('b');

    expect(result.credentialRemoved).toBe(true);
    expect(result.defaultProvider).toBe('a');
    expect(readConfig().default).toBe('a');
    expect(credentials.loadCredentials().b).toBeUndefined();
    expect(() => parseConfig(readConfig())).not.toThrow();
  });

  it('si queda vacía siembra mock como default', () => {
    store.addProvider('a', { preset: 'llamacpp' });

    const result = store.removeProvider('a');

    expect(result.seededMock).toBe(true);
    expect(result.defaultProvider).toBe('mock');
    const config = readConfig();
    expect(config.default).toBe('mock');
    expect(config.providers).toEqual({ mock: { kind: 'mock' } });
    expect(() => parseConfig(config)).not.toThrow();
  });

  it('E_INPUT si el alias no existe', () => {
    const error = catchM1(() => store.removeProvider('nope'));
    expect(error.code).toBe('E_INPUT');
    expect(error.hint).toContain('m1 provider list');
  });
});

describe('listProviders / describeProvider', () => {
  it('marca el default y no expone secretos', () => {
    store.addProvider('a', { preset: 'llamacpp' });
    store.addProvider('ts', { preset: 'typesafe', apiKey: 'sk-secret-xyz' });

    const rows = store.listProviders();
    expect(rows.map((row) => row.alias)).toEqual(['a', 'ts']);
    expect(rows.find((row) => row.alias === 'a')?.isDefault).toBe(true);
    expect(rows.find((row) => row.alias === 'ts')?.isDefault).toBe(false);
    expect(rows.find((row) => row.alias === 'ts')?.keySource).toBe('credentials');
    expect(JSON.stringify(rows)).not.toContain('sk-secret-xyz');
  });

  it('resume kind, modelo ausente por defecto, launch y default', () => {
    store.addProvider('local', { preset: 'llamacpp' });

    const description = store.describeProvider('local', store.getProvider('local'), 'local');

    expect(description).toMatchObject({
      alias: 'local',
      kind: 'systemone',
      modelSource: 'ninguna',
      launch: true,
      launchCommand: 'llama-server',
      isDefault: true,
      hasApiKey: false,
      keySource: '—',
      hasAccountId: false,
    });
    // El preset llamacpp no fija modelo: se elige después con `provider edit --model`.
    expect(description.model).toBeUndefined();
  });

  it('detecta la api key desde el entorno', () => {
    store.addProvider('ts', { preset: 'typesafe' });
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key');

    const description = store.describeProvider('ts', store.getProvider('ts'));
    expect(description.hasApiKey).toBe(true);
    expect(description.keySource).toBe('env');
  });
});

describe('parseConfig: launch sin args', () => {
  const base = {
    kind: 'systemone',
    baseUrl: 'http://127.0.0.1:9931/v1/systemone',
  };

  it('acepta launch sin args y con args vacío', () => {
    const withoutArgs = parseConfig({
      providers: { local: { ...base, launch: { port: 9931 } } },
    });
    expect(withoutArgs.providers.local?.launch).toEqual({ port: 9931 });

    const emptyArgs = parseConfig({
      providers: { local: { ...base, launch: { args: [] } } },
    });
    expect(emptyArgs.providers.local?.launch?.args).toEqual([]);
  });

  it('sigue rechazando args con elementos que no son strings', () => {
    const error = catchM1(() =>
      parseConfig({ providers: { local: { ...base, launch: { args: ['-hf', 1] } } } }),
    );
    expect(error.code).toBe('E_CONFIG');
    expect(error.message).toContain('args');
  });
});