import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { M1Error } from '../core/errors';
import { isLoopbackHost, parseLocalEndpoint } from '../local/lifecycle';
import type { LocalLaunchConfig, ProviderConfig, ProviderKind } from '../providers/types';

export interface AppConfig {
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
  source?: string;
}

const VALID_KINDS: ProviderKind[] = ['cloudflare', 'typesafe', 'openrouter', 'systemone', 'mock'];

/** Carga .env del cwd si existe. No pisa variables ya definidas. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = join(cwd, '.env');
  if (!existsSync(file)) return;
  try {
    // Node >= 20.12: no pisa las variables existentes por defecto.
    process.loadEnvFile(file);
  } catch {
    /* .env malformado: seguimos con el entorno actual */
  }
}

export function configCandidates(cwd = process.cwd()): string[] {
  const home = homedir();
  return [join(cwd, 'm1.config.json'), join(home, '.config', 'm1-agent', 'config.json')];
}

export function findConfigPath(explicit?: string, cwd = process.cwd()): string | undefined {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(p)) {
      throw new M1Error('E_CONFIG', `no existe el archivo de config: ${p}`, {
        hint: 'creá m1.config.json o pasá --config con una ruta válida',
      });
    }
    return p;
  }
  return configCandidates(cwd).find((p) => existsSync(p));
}

function parseLaunch(alias: string, raw: unknown): LocalLaunchConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new M1Error('E_CONFIG', `provider "${alias}": launch inválido`, {
      hint: 'debe ser un objeto, ej: { "args": ["-hf", "LiquidAI/d1-2B-GGUF:Q8_0"] }',
    });
  }
  const p = raw as Record<string, unknown>;
  const launch: LocalLaunchConfig = {};

  if (p.command !== undefined) {
    if (typeof p.command !== 'string' || p.command.trim() === '') {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch.command debe ser un string no vacío`);
    }
    launch.command = p.command.trim();
  }

  if (p.args !== undefined) {
    if (
      !Array.isArray(p.args) ||
      p.args.length === 0 ||
      p.args.some((arg) => typeof arg !== 'string')
    ) {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch.args debe ser un array de strings no vacío`, {
        hint: 'ej: ["-hf", "LiquidAI/d1-2B-GGUF:Q8_0"]',
      });
    }
    launch.args = [...(p.args as string[])];
  }
  if (!launch.args) {
    throw new M1Error('E_CONFIG', `provider "${alias}": launch requiere args`, {
      hint: 'ej: "launch": { "args": ["-hf", "LiquidAI/d1-2B-GGUF:Q8_0"] }',
    });
  }

  if (p.port !== undefined) {
    if (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65_535) {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch.port debe ser un entero entre 1 y 65535`);
    }
    launch.port = p.port;
  }

  if (p.healthPath !== undefined) {
    if (typeof p.healthPath !== 'string' || p.healthPath.trim() === '') {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch.healthPath debe ser un string no vacío`);
    }
    launch.healthPath = p.healthPath.trim();
  }

  if (p.startTimeoutMs !== undefined) {
    if (typeof p.startTimeoutMs !== 'number' || !Number.isInteger(p.startTimeoutMs) || p.startTimeoutMs <= 0) {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch.startTimeoutMs debe ser un entero positivo`);
    }
    launch.startTimeoutMs = p.startTimeoutMs;
  }

  if (p.autoStart !== undefined) {
    if (p.autoStart !== 'ask' && p.autoStart !== 'always' && p.autoStart !== 'never') {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch.autoStart debe ser ask, always o never`);
    }
    launch.autoStart = p.autoStart;
  }

  return launch;
}

function parseProvider(alias: string, raw: unknown): ProviderConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new M1Error('E_CONFIG', `provider "${alias}" inválido`, { hint: 'debe ser un objeto con al menos { "kind": ... }' });
  }
  const p = raw as Record<string, unknown>;
  const kind = p.kind;
  if (typeof kind !== 'string' || !VALID_KINDS.includes(kind as ProviderKind)) {
    throw new M1Error('E_CONFIG', `provider "${alias}": kind inválido "${String(kind)}"`, {
      hint: `kinds válidos: ${VALID_KINDS.join(', ')}`,
    });
  }
  const cfg: ProviderConfig = { kind: kind as ProviderKind };
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const model = str(p.model);
  if (model) cfg.model = model;
  const baseUrl = str(p.baseUrl);
  if (baseUrl) cfg.baseUrl = baseUrl;
  const accountId = str(p.accountId);
  if (accountId) cfg.accountId = accountId;
  const apiKeyEnv = str(p.apiKeyEnv);
  if (apiKeyEnv) cfg.apiKeyEnv = apiKeyEnv;
  const apiKey = str(p.apiKey);
  if (apiKey) cfg.apiKey = apiKey;
  if (p.headers && typeof p.headers === 'object') cfg.headers = p.headers as Record<string, string>;
  if (p.unwrap === 'auto' || p.unwrap === 'result' || p.unwrap === 'none') cfg.unwrap = p.unwrap;
  if (typeof p.timeoutMs === 'number') cfg.timeoutMs = p.timeoutMs;
  if (p.imageFormat !== undefined) {
    if (p.imageFormat !== 'object' && p.imageFormat !== 'dataUrl') {
      throw new M1Error('E_CONFIG', `provider "${alias}": imageFormat debe ser object o dataUrl`);
    }
    if (cfg.kind !== 'systemone') {
      throw new M1Error('E_CONFIG', `provider "${alias}": imageFormat sólo aplica a kind "systemone"`);
    }
    cfg.imageFormat = p.imageFormat;
  }
  const fixturesDir = str(p.fixturesDir);
  if (fixturesDir) cfg.fixturesDir = fixturesDir;
  if (cfg.kind === 'systemone' && !cfg.baseUrl) {
    throw new M1Error('E_CONFIG', `provider "${alias}" (systemone) requiere baseUrl`, {
      hint: 'ej: "baseUrl": "http://localhost:8000/v1/systemone"',
    });
  }
  if (p.launch !== undefined) {
    if (cfg.kind !== 'systemone') {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch sólo aplica a kind "systemone"`);
    }
    cfg.launch = parseLaunch(alias, p.launch);
  }
  if (cfg.launch) {
    const endpoint = parseLocalEndpoint(cfg.baseUrl!);
    if (!isLoopbackHost(endpoint.host)) {
      throw new M1Error('E_CONFIG', `provider "${alias}": launch requiere un baseUrl loopback`, {
        hint: `"${endpoint.host}" no es local; usá 127.0.0.1 o localhost`,
      });
    }
  }
  return cfg;
}

export function parseConfig(raw: unknown, source?: string): AppConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new M1Error('E_CONFIG', 'la config debe ser un objeto JSON', { hint: 'ver m1.config.example.json' });
  }
  const obj = raw as Record<string, unknown>;
  const providersRaw = obj.providers;
  if (typeof providersRaw !== 'object' || providersRaw === null) {
    throw new M1Error('E_CONFIG', 'la config no tiene "providers"', { hint: 'agregá { "providers": { "cf": { "kind": "cloudflare" } } }' });
  }
  const providers: Record<string, ProviderConfig> = {};
  for (const [alias, value] of Object.entries(providersRaw as Record<string, unknown>)) {
    providers[alias] = parseProvider(alias, value);
  }
  const aliases = Object.keys(providers);
  if (aliases.length === 0) {
    throw new M1Error('E_CONFIG', 'no hay providers configurados', { hint: 'configurá al menos uno (cloudflare, typesafe, systemone o mock)' });
  }
  const def = typeof obj.default === 'string' ? obj.default : (obj.defaultProvider as string | undefined);
  const defaultProvider = def ?? (aliases.includes('cf') ? 'cf' : aliases[0]!);
  if (!providers[defaultProvider]) {
    throw new M1Error('E_CONFIG', `default provider "${defaultProvider}" no existe`, {
      hint: `aliases disponibles: ${aliases.join(', ')}`,
    });
  }
  return { defaultProvider, providers, source };
}

export function loadConfig(opts: { explicit?: string; cwd?: string } = {}): AppConfig {
  const cwd = opts.cwd ?? process.cwd();
  loadDotEnv(cwd);
  const path = findConfigPath(opts.explicit, cwd);
  if (!path) {
    // Config de emergencia: mock, para que la CLI nunca quede inutilizable.
    return { defaultProvider: 'mock', providers: { mock: { kind: 'mock' } }, source: '(builtin)' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new M1Error('E_CONFIG', `no se pudo leer la config: ${path}`, {
      hint: 'verificá que sea JSON válido',
      cause: e,
    });
  }
  return parseConfig(raw, path);
}

export function resolveProvider(
  config: AppConfig,
  alias?: string,
  overrides: { model?: string; timeoutMs?: number } = {},
): { alias: string; config: ProviderConfig } {
  const name = alias ?? config.defaultProvider;
  const found = config.providers[name];
  if (!found) {
    throw new M1Error('E_CONFIG', `provider "${name}" no está configurado`, {
      hint: `disponibles: ${Object.keys(config.providers).join(', ')}`,
    });
  }
  const merged: ProviderConfig = { ...found };
  if (overrides.model) merged.model = overrides.model;
  if (overrides.timeoutMs) merged.timeoutMs = overrides.timeoutMs;
  return { alias: name, config: merged };
}
