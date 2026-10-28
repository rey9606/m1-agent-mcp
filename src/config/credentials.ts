import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { M1Error } from '../core/errors';
import type { ProviderConfig } from '../providers/types';

export interface Credential {
  apiKey?: string;
  accountId?: string;
}

export type Credentials = Record<string, Credential>;

export function credentialsPath(): string {
  return join(homedir(), '.config', 'm1-agent', 'credentials.json');
}

export function loadCredentials(): Credentials {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Credentials;
    return typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    throw new M1Error('E_CONFIG', `credenciales ilegibles: ${path}`, { hint: 'borrá el archivo y volvé a autenticar con `m1 auth set`' });
  }
}

function writeCredentials(creds: Credentials): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* en Windows el modo POSIX es best-effort */
  }
}

export function saveCredential(alias: string, credential: Credential): void {
  const creds = loadCredentials();
  creds[alias] = { ...creds[alias], ...credential };
  writeCredentials(creds);
}

export function deleteCredential(alias: string): boolean {
  const creds = loadCredentials();
  if (!(alias in creds)) return false;
  delete creds[alias];
  writeCredentials(creds);
  return true;
}

/**
 * Resuelve secreto + accountId.
 * Precedencia: config (apiKey/accountId explícito) > env (apiKeyEnv / *_ACCOUNT_ID) > credentials.json[alias].
 */
export function resolveSecrets(alias: string, cfg: ProviderConfig): Credential {
  const creds = loadCredentials()[alias] ?? {};
  const apiKey = cfg.apiKey ?? (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) ?? creds.apiKey;
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? creds.accountId;
  return { apiKey: apiKey || undefined, accountId: accountId || undefined };
}

export function redact(value: string | undefined): string {
  if (!value) return '(sin definir)';
  if (value.length <= 6) return '***';
  return `${value.slice(0, 3)}…${value.slice(-2)} (len ${value.length})`;
}
