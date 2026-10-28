/**
 * CRUD de providers sobre la config global (`~/.config/m1-agent/config.json`).
 *
 * Reglas:
 * - la config de providers se escribe SIEMPRE en la config global;
 * - los secretos (`--api-key`) van a `credentials.json` (0600), nunca al JSON
 *   de config;
 * - toda mutación se valida con `parseConfig` antes de tocar el disco.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { M1Error } from '../core/errors';
import { defaultModelFor } from '../providers/registry';
import { parseConfig } from './config';
import { deleteCredential, loadCredentials, saveCredential } from './credentials';
import type { LocalLaunchConfig, ProviderConfig, ProviderKind } from '../providers/types';

/** Aliases válidos: minúsculas, números, `-` y `_` (1 a 32 caracteres). */
export const PROVIDER_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  'cloudflare',
  'typesafe',
  'openrouter',
  'systemone',
  'mock',
];

export type ProviderPresetId = 'cloudflare' | 'openrouter' | 'typesafe' | 'llamacpp' | 'custom';

export interface ProviderPreset {
  id: ProviderPresetId;
  title: string;
  description: string;
  kind: ProviderKind;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  requiresApiKey: boolean;
  requiresAccountId: boolean;
  launch?: LocalLaunchConfig;
}

/**
 * Presets listos para `m1 provider add <alias> --preset <id>`.
 * `llamacpp` sirve el modelo con `llama-server` (kind systemone + launch),
 * sin `model`: el servidor decide qué pesos carga.
 */
export const PROVIDER_PRESETS: Record<ProviderPresetId, ProviderPreset> = {
  cloudflare: {
    id: 'cloudflare',
    title: 'Cloudflare Workers AI (Clef Flash)',
    description: 'Clef Flash en Workers AI. Necesita API token y account id; el provider arma la URL con la cuenta.',
    kind: 'cloudflare',
    model: '@cf/cloudflare/clef-flash',
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    requiresApiKey: true,
    requiresAccountId: true,
  },
  openrouter: {
    id: 'openrouter',
    title: 'OpenRouter',
    description: 'Modelos publicados en OpenRouter con una sola API key.',
    kind: 'openrouter',
    model: 'typesafe/jev-1.14',
    apiKeyEnv: 'OPENROUTER_KEY',
    requiresApiKey: true,
    requiresAccountId: false,
  },
  typesafe: {
    id: 'typesafe',
    title: 'TypeSafe (JEV)',
    description: 'Decisiones JEV contra api.typesafe.ai con API key.',
    kind: 'typesafe',
    model: 'jev-latest',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    requiresApiKey: true,
    requiresAccountId: false,
  },
  llamacpp: {
    id: 'llamacpp',
    title: 'llama.cpp local (llama-server)',
    description: 'Endpoint systemone local en 127.0.0.1:9931. La CLI levanta llama-server si no responde.',
    kind: 'systemone',
    baseUrl: 'http://127.0.0.1:9931/v1/systemone',
    requiresApiKey: false,
    requiresAccountId: false,
    launch: {
      command: 'llama-server',
      args: [],
      port: 9931,
      startTimeoutMs: 120_000,
      autoStart: 'always',
      console: true,
    },
  },
  custom: {
    id: 'custom',
    title: 'Endpoint systemone propio',
    description: 'Cualquier endpoint compatible con el contrato systemone. La API key es opcional (M1_API_KEY).',
    kind: 'systemone',
    model: 'local-decision',
    apiKeyEnv: 'M1_API_KEY',
    requiresApiKey: false,
    requiresAccountId: false,
  },
};

export function presetIds(): string[] {
  return Object.keys(PROVIDER_PRESETS);
}

export function findPreset(id: string): ProviderPreset | undefined {
  const key = id.trim();
  return Object.hasOwn(PROVIDER_PRESETS, key) ? PROVIDER_PRESETS[key as ProviderPresetId] : undefined;
}

export interface GlobalConfigFile {
  raw: Record<string, unknown>;
  path: string;
  exists: boolean;
}

/** Ruta de la config global; la misma que usa `configCandidates`. */
export function globalConfigPath(): string {
  return join(homedir(), '.config', 'm1-agent', 'config.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Lee la config global sin validarla (para poder repararla/mostrarla). */
export function loadGlobalConfig(): GlobalConfigFile {
  const path = globalConfigPath();
  if (!existsSync(path)) {
    return { raw: { providers: {} }, path, exists: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new M1Error('E_CONFIG', `no se pudo leer la config global: ${path}`, {
      hint: 'verificá que sea JSON válido (o borralo para empezar de cero)',
      cause,
    });
  }
  if (!isRecord(parsed)) {
    throw new M1Error('E_CONFIG', `la config global no es un objeto JSON: ${path}`, {
      hint: 'reemplazala por { "providers": { ... } }',
    });
  }
  const raw: Record<string, unknown> = { ...parsed };
  if (!isRecord(raw.providers)) raw.providers = {};
  return { raw, path, exists: true };
}

/** Escribe la config global de forma atómica (tmp + rename). Nunca valida. */
export function saveGlobalConfig(raw: Record<string, unknown>): string {
  const path = globalConfigPath();
  const out: Record<string, unknown> = { ...raw };
  if (!isRecord(out.providers)) out.providers = {};
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (cause) {
    rmSync(tmp, { force: true });
    throw new M1Error('E_CONFIG', `no se pudo escribir la config global: ${path}`, {
      hint: 'revisá permisos del directorio ~/.config/m1-agent',
      cause,
    });
  }
  return path;
}

function providersOf(raw: Record<string, unknown>): Record<string, unknown> {
  return isRecord(raw.providers) ? { ...raw.providers } : {};
}

function effectiveDefaultAlias(
  raw: Record<string, unknown>,
  providers = providersOf(raw),
): string | undefined {
  const declared = str(raw.default) ?? str(raw.defaultProvider);
  if (declared && providers[declared] !== undefined) return declared;
  const aliases = Object.keys(providers);
  if (aliases.includes('cf')) return 'cf';
  return aliases[0];
}

function assertAlias(alias: string, code: 'E_USAGE' | 'E_INPUT'): string {
  const value = alias.trim();
  if (!PROVIDER_ALIAS_PATTERN.test(value)) {
    throw new M1Error(code, `alias inválido: "${alias}"`, {
      hint: 'usá minúsculas, números, "-" o "_" (1 a 32 caracteres, empezando por letra o número)',
      details: { alias, pattern: PROVIDER_ALIAS_PATTERN.source },
    });
  }
  return value;
}

function missingProvider(alias: string): M1Error {
  return new M1Error('E_INPUT', `no existe el provider "${alias}"`, {
    hint: 'mirá los configurados con `m1 provider list` y agregalo con `m1 provider add`',
    details: { alias },
  });
}

function coerceProviderConfig(value: unknown): ProviderConfig {
  if (!isRecord(value)) return { kind: 'mock' };
  return { ...(value as unknown as ProviderConfig) };
}

function parseSingleProvider(alias: string, value: unknown): ProviderConfig {
  const config = parseConfig({ default: alias, providers: { [alias]: value } });
  return config.providers[alias]!;
}

function safeCredentials(alias: string): { apiKey?: string; accountId?: string } {
  try {
    return loadCredentials()[alias] ?? {};
  } catch {
    return {};
  }
}

export type KeySource = 'config' | 'env' | 'credentials' | '—';

export interface ProviderDescription {
  alias: string;
  kind: string;
  model?: string;
  modelSource: 'config' | 'default' | 'ninguna';
  baseUrl?: string;
  apiKeyEnv?: string;
  hasApiKey: boolean;
  keySource: KeySource;
  hasAccountId: boolean;
  launch: boolean;
  launchCommand?: string;
  isDefault: boolean;
}

/** Env vars que `resolveSecrets` usa por defecto cuando no hay `apiKeyEnv`. */
const DEFAULT_KEY_ENV: Partial<Record<ProviderKind, string>> = {
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  openrouter: 'OPENROUTER_KEY',
};

/** Resume un provider para `list`/`show` sin revelar secretos. */
export function describeProvider(
  alias: string,
  cfg: ProviderConfig,
  defaultAlias?: string,
): ProviderDescription {
  const configuredModel = str(cfg.model);
  let fallbackModel: string | undefined;
  // Un servidor local (llama.cpp) puede no tener modelo asociado: eso se
  // configura después y no debe mostrarse como si tuviera el default del kind.
  if (!configuredModel && cfg.launch === undefined) {
    try {
      fallbackModel = defaultModelFor(cfg.kind);
    } catch {
      fallbackModel = undefined;
    }
  }

  const creds = safeCredentials(alias);
  const apiKeyEnv = cfg.apiKeyEnv ?? DEFAULT_KEY_ENV[cfg.kind];
  const envApiKey = apiKeyEnv ? Boolean(process.env[apiKeyEnv]) : false;
  const hasConfigKey = Boolean(cfg.apiKey);
  const hasCredentialKey = Boolean(creds.apiKey);
  const keySource: KeySource = hasConfigKey
    ? 'config'
    : envApiKey
      ? 'env'
      : hasCredentialKey
        ? 'credentials'
        : '—';

  const envAccountId = cfg.kind === 'cloudflare' ? Boolean(process.env.CLOUDFLARE_ACCOUNT_ID) : false;

  return {
    alias,
    kind: String(cfg.kind ?? '(inválido)'),
    model: configuredModel ?? fallbackModel,
    modelSource: configuredModel ? 'config' : fallbackModel ? 'default' : 'ninguna',
    baseUrl: str(cfg.baseUrl),
    apiKeyEnv,
    hasApiKey: hasConfigKey || envApiKey || hasCredentialKey,
    keySource,
    hasAccountId: Boolean(str(cfg.accountId)) || envAccountId || Boolean(creds.accountId),
    launch: cfg.launch !== undefined,
    launchCommand: str(cfg.launch?.command),
    isDefault: alias === defaultAlias,
  };
}

/** Lista los providers de la config global (tolera entries inválidas). */
export function listProviders(): ProviderDescription[] {
  const { raw } = loadGlobalConfig();
  const providers = providersOf(raw);
  const defaultAlias = effectiveDefaultAlias(raw, providers);
  return Object.entries(providers).map(([alias, value]) =>
    describeProvider(alias, coerceProviderConfig(value), defaultAlias),
  );
}

/** Devuelve el provider ya validado; E_INPUT si el alias no existe. */
export function getProvider(alias: string): ProviderConfig {
  const name = assertAlias(alias, 'E_INPUT');
  const { raw } = loadGlobalConfig();
  const providers = providersOf(raw);
  if (providers[name] === undefined) throw missingProvider(name);
  return parseSingleProvider(name, providers[name]);
}

export interface AddProviderOptions {
  preset?: string;
  kind?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  accountId?: string;
  default?: boolean;
}

export interface ProviderMutationResult {
  alias: string;
  config: ProviderConfig;
  defaultProvider: string;
  path: string;
  changed: string[];
  apiKeyStored: boolean;
}

function resolveKind(kind: string | undefined, preset: ProviderPreset | undefined): ProviderKind {
  if (preset) return preset.kind;
  const value = str(kind);
  if (!value) {
    throw new M1Error('E_USAGE', 'falta el kind del provider', {
      hint: `pasá --preset <${presetIds().join('|')}> o --kind <${PROVIDER_KINDS.join('|')}>`,
    });
  }
  if (!PROVIDER_KINDS.includes(value as ProviderKind)) {
    throw new M1Error('E_USAGE', `kind inválido: "${value}"`, {
      hint: `kinds válidos: ${PROVIDER_KINDS.join(', ')}`,
      details: { kind: value },
    });
  }
  return value as ProviderKind;
}

/** Agrega un provider a la config global y, si hay `--api-key`, la guarda en credentials. */
export function addProvider(alias: string, opts: AddProviderOptions = {}): ProviderMutationResult {
  const name = assertAlias(alias, 'E_USAGE');
  const { raw } = loadGlobalConfig();
  const providers = providersOf(raw);

  if (providers[name] !== undefined) {
    throw new M1Error('E_USAGE', `el provider "${name}" ya existe`, {
      hint: `usá \`m1 provider edit ${name} ...\` para cambiarlo, o \`m1 provider remove ${name} --yes\` y volvé a agregarlo`,
      details: { alias: name },
    });
  }
  if (opts.preset !== undefined && opts.kind !== undefined) {
    throw new M1Error('E_USAGE', '--preset y --kind son excluyentes', {
      hint: 'elegí un preset o armá el provider con --kind y sus flags',
    });
  }

  const preset = opts.preset !== undefined ? findPreset(opts.preset) : undefined;
  if (opts.preset !== undefined && !preset) {
    throw new M1Error('E_USAGE', `no existe el preset "${opts.preset}"`, {
      hint: `presets disponibles: ${presetIds().join(', ')} (mirá \`m1 provider presets\`)`,
      details: { presets: presetIds() },
    });
  }

  const kind = resolveKind(opts.kind, preset);
  const cfg: ProviderConfig = { kind };
  const changed: string[] = ['kind'];

  const model = str(opts.model) ?? preset?.model;
  if (model) {
    cfg.model = model;
    changed.push('model');
  }

  const baseUrl = str(opts.baseUrl) ?? preset?.baseUrl;
  if (kind === 'systemone' && !baseUrl) {
    throw new M1Error('E_INPUT', `provider "${name}" (systemone) requiere baseUrl`, {
      hint: 'pasá --base-url http://127.0.0.1:8000/v1/systemone, o usá --preset llamacpp',
      details: { alias: name },
    });
  }
  if (baseUrl) {
    cfg.baseUrl = baseUrl;
    changed.push('baseUrl');
  }

  const apiKeyEnv = str(opts.apiKeyEnv) ?? preset?.apiKeyEnv;
  if (apiKeyEnv) {
    cfg.apiKeyEnv = apiKeyEnv;
    changed.push('apiKeyEnv');
  }

  if (preset?.launch) {
    cfg.launch = { ...preset.launch, args: [...(preset.launch.args ?? [])] };
    changed.push('launch');
  }

  const accountId = str(opts.accountId);
  if (kind === 'cloudflare') {
    const envAccountId = str(process.env.CLOUDFLARE_ACCOUNT_ID);
    if (!accountId && !envAccountId) {
      throw new M1Error('E_INPUT', `provider "${name}" (cloudflare) requiere account id`, {
        hint: 'pasá --account-id <id> (o definí CLOUDFLARE_ACCOUNT_ID en el entorno/.env)',
        details: { alias: name },
      });
    }
    if (accountId) {
      cfg.accountId = accountId;
      changed.push('accountId');
    }
  } else if (accountId) {
    cfg.accountId = accountId;
    changed.push('accountId');
  }

  const apiKey = str(opts.apiKey);
  if (apiKey) changed.push('apiKey (credentials)');

  const declaredDefault = str(raw.default) ?? str(raw.defaultProvider);
  const defaultProvider = opts.default
    ? name
    : declaredDefault && providers[declaredDefault] !== undefined
      ? declaredDefault
      : name;
  const next: Record<string, unknown> = {
    ...raw,
    default: defaultProvider,
    providers: { ...providers, [name]: cfg },
  };
  parseConfig(next);
  const path = saveGlobalConfig(next);

  if (apiKey) saveCredential(name, { apiKey });

  return { alias: name, config: cfg, defaultProvider, path, changed, apiKeyStored: Boolean(apiKey) };
}

export interface EditProviderOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  accountId?: string;
  clearApiKey?: boolean;
}

/**
 * Cambia sólo los campos provistos. `--api-key` va a credentials y
 * `--clear-api-key` borra la credencial guardada.
 */
export function editProvider(alias: string, patch: EditProviderOptions = {}): ProviderMutationResult {
  const name = assertAlias(alias, 'E_INPUT');
  const { raw } = loadGlobalConfig();
  const providers = providersOf(raw);
  const existing = providers[name];
  if (existing === undefined) throw missingProvider(name);
  if (!isRecord(existing)) {
    throw new M1Error('E_CONFIG', `el provider "${name}" no es un objeto`, {
      hint: `borralo con \`m1 provider remove ${name} --yes\` y volvé a agregarlo`,
    });
  }

  const provider: Record<string, unknown> = { ...existing };
  const changed: string[] = [];

  if (patch.baseUrl !== undefined) {
    const baseUrl = patch.baseUrl.trim();
    if (!baseUrl) {
      throw new M1Error('E_USAGE', '--base-url no puede estar vacío', {
        hint: 'pasá la URL completa, ej: http://127.0.0.1:9931/v1/systemone',
      });
    }
    provider.baseUrl = baseUrl;
    changed.push('baseUrl');
  }
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (model) provider.model = model;
    else delete provider.model;
    changed.push('model');
  }
  if (patch.apiKeyEnv !== undefined) {
    const apiKeyEnv = patch.apiKeyEnv.trim();
    if (apiKeyEnv) provider.apiKeyEnv = apiKeyEnv;
    else delete provider.apiKeyEnv;
    changed.push('apiKeyEnv');
  }
  if (patch.accountId !== undefined) {
    const accountId = patch.accountId.trim();
    if (accountId) provider.accountId = accountId;
    else delete provider.accountId;
    changed.push('accountId');
  }

  const apiKey = patch.apiKey !== undefined ? patch.apiKey.trim() : '';
  if (patch.apiKey !== undefined && !apiKey) {
    throw new M1Error('E_USAGE', '--api-key no puede estar vacío', {
      hint: 'para borrar la key guardada usá --clear-api-key',
    });
  }
  if (apiKey) {
    // Los secretos nunca viven en el JSON de config.
    if (provider.apiKey !== undefined) delete provider.apiKey;
    changed.push('apiKey (credentials)');
  }
  if (patch.clearApiKey) changed.push('apiKey (borrada)');

  if (changed.length === 0) {
    throw new M1Error('E_USAGE', `no hay cambios para "${name}"`, {
      hint: 'pasá al menos uno de: --base-url, --model, --api-key, --api-key-env, --account-id, --clear-api-key',
    });
  }

  const currentDefault = effectiveDefaultAlias(raw, providers);
  const next: Record<string, unknown> = {
    ...raw,
    default: currentDefault ?? name,
    providers: { ...providers, [name]: provider },
  };
  parseConfig(next);
  const path = saveGlobalConfig(next);

  if (apiKey) saveCredential(name, { apiKey });
  let credentialRemoved = false;
  if (patch.clearApiKey) credentialRemoved = deleteCredential(name);

  const config = parseSingleProvider(name, provider);
  return {
    alias: name,
    config,
    defaultProvider: currentDefault ?? name,
    path,
    changed: credentialRemoved
      ? [...changed, 'credentials']
      : changed,
    apiKeyStored: Boolean(apiKey),
  };
}

export interface RemoveProviderOptions {
  force?: boolean;
}

export interface RemoveProviderResult {
  alias: string;
  defaultProvider: string;
  credentialRemoved: boolean;
  seededMock: boolean;
  path: string;
}

/**
 * Borra un provider y su credencial. No permite borrar el default si quedan
 * otros providers, salvo `--force`. Si la config queda vacía, siembra `mock`.
 */
export function removeProvider(alias: string, opts: RemoveProviderOptions = {}): RemoveProviderResult {
  const name = assertAlias(alias, 'E_INPUT');
  const { raw } = loadGlobalConfig();
  const providers = providersOf(raw);
  if (providers[name] === undefined) throw missingProvider(name);

  const currentDefault = effectiveDefaultAlias(raw, providers);
  const others = Object.keys(providers).filter((other) => other !== name);
  if (name === currentDefault && others.length > 0 && !opts.force) {
    throw new M1Error('E_USAGE', `"${name}" es el provider default`, {
      hint: `elegí otro antes (\`m1 provider use ${others[0]}\`) o pasá --force`,
      details: { alias: name, others },
    });
  }

  delete providers[name];
  let seededMock = false;
  let defaultProvider =
    currentDefault === name || currentDefault === undefined ? (others[0] ?? 'mock') : currentDefault;

  if (Object.keys(providers).length === 0) {
    // La CLI nunca debe quedar sin providers: `mock` es la salida de emergencia.
    providers.mock = { kind: 'mock' };
    defaultProvider = 'mock';
    seededMock = true;
  }

  const next: Record<string, unknown> = { ...raw, default: defaultProvider, providers };
  parseConfig(next);
  const path = saveGlobalConfig(next);
  const credentialRemoved = deleteCredential(name);

  return { alias: name, defaultProvider, credentialRemoved, seededMock, path };
}

export interface SetDefaultResult {
  alias: string;
  previous?: string;
  path: string;
}

/** Fija `default` en la config global; valida que el alias exista. */
export function setDefaultProvider(alias: string): SetDefaultResult {
  const name = assertAlias(alias, 'E_INPUT');
  const { raw } = loadGlobalConfig();
  const providers = providersOf(raw);
  if (providers[name] === undefined) throw missingProvider(name);

  const previous = effectiveDefaultAlias(raw, providers);
  const next: Record<string, unknown> = { ...raw, default: name, providers };
  parseConfig(next);
  const path = saveGlobalConfig(next);
  return { alias: name, previous, path };
}