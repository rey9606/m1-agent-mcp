import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface Preferences {
  /** Alias de provider → id de modelo preferido por el usuario. */
  models?: Record<string, string>;
}

export function preferencesPath(): string {
  return join(homedir(), '.config', 'm1-agent', 'preferences.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lee preferencias. Si el archivo está roto devuelve `{}` y, si se pasa un
 * array, agrega un warning (nunca explota).
 */
export function loadPreferences(warnings?: string[]): Preferences {
  const path = preferencesPath();
  if (!existsSync(path)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    warnings?.push(`preferences.json ilegible (${path}): se ignoran las preferencias guardadas`);
    return {};
  }

  if (!isRecord(parsed)) {
    warnings?.push(`preferences.json inválido (${path}): se ignoran las preferencias guardadas`);
    return {};
  }

  const modelsRaw = parsed.models;
  if (!isRecord(modelsRaw)) return {};

  const models: Record<string, string> = {};
  for (const [alias, value] of Object.entries(modelsRaw)) {
    if (typeof value === 'string' && value.trim() !== '') models[alias] = value.trim();
  }
  return Object.keys(models).length > 0 ? { models } : {};
}

/** Escritura atómica best-effort (tmp + rename), modo 0600 best-effort. */
function writePreferences(preferences: Preferences): void {
  const path = preferencesPath();
  mkdirSync(dirname(path), { recursive: true });

  const payload = `${JSON.stringify(preferences, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* en Windows el modo POSIX es best-effort */
  }

  try {
    renameSync(tmp, path);
  } catch {
    // Si el rename falla (p. ej. antivirus en Windows), escribimos directo.
    try {
      writeFileSync(path, payload, { encoding: 'utf8', mode: 0o600 });
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best-effort */
  }
}

export function savePreferredModel(alias: string, model: string): void {
  const preferences = loadPreferences();
  preferences.models = { ...(preferences.models ?? {}), [alias]: model };
  writePreferences(preferences);
}

/** Borra la preferencia del alias. Devuelve `true` si existía. */
export function clearPreferredModel(alias: string): boolean {
  const preferences = loadPreferences();
  const models = preferences.models;
  if (!models || !(alias in models)) return false;
  delete models[alias];
  writePreferences(preferences);
  return true;
}

export function getPreferredModel(alias: string): string | undefined {
  return loadPreferences().models?.[alias];
}
