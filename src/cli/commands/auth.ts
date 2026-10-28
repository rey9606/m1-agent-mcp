import { M1Error } from '../../core/errors';
import { loadConfig } from '../../config/config';
import { deleteCredential, loadCredentials, redact, resolveSecrets, saveCredential } from '../../config/credentials';
import { fail } from '../output';

export interface AuthFlags {
  json?: boolean;
  config?: string;
  token?: string;
  accountId?: string;
  env?: string;
}

export function authSetCommand(alias: string, flags: AuthFlags): never {
  try {
    if (flags.env) {
      saveCredential(alias, { apiKeyEnv: flags.env });
      const payload = {
        ok: true,
        alias,
        stored: true,
        apiKeyEnv: flags.env,
        message: `"${alias}" usará la variable de entorno ${flags.env}; definila en tu .env o en el entorno`,
      };
      process.stdout.write((flags.json ? JSON.stringify(payload) : `  ✓ ${payload.message}`) + '\n');
      process.exit(0);
    }
    if (!flags.token && !flags.accountId) {
      throw new M1Error('E_USAGE', 'no hay nada para guardar', {
        hint: 'usá --token <key> (y --account-id <id> para Cloudflare), o --env VAR para apuntar a una variable de entorno',
      });
    }
    const credential: { apiKey?: string; accountId?: string } = {};
    if (flags.token) credential.apiKey = flags.token;
    if (flags.accountId) credential.accountId = flags.accountId;
    saveCredential(alias, credential);
    const payload = { ok: true, alias, stored: true, apiKey: redact(credential.apiKey), accountId: credential.accountId ? redact(credential.accountId) : undefined };
    process.stdout.write((flags.json ? JSON.stringify(payload) : `  ✓ credencial guardada para "${alias}"`) + '\n');
    process.exit(0);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}

export function authStatusCommand(flags: AuthFlags): never {
  try {
    const config = loadConfig({ explicit: flags.config });
    const creds = loadCredentials();
    const rows = Object.entries(config.providers).map(([alias, cfg]) => {
      const secrets = resolveSecrets(alias, cfg);
      return {
        alias,
        kind: cfg.kind,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        hasApiKey: Boolean(secrets.apiKey),
        apiKey: redact(secrets.apiKey),
        hasAccountId: Boolean(secrets.accountId),
        inCredentialsFile: Boolean(creds[alias]),
      };
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, configSource: config.source, providers: rows }) + '\n');
    } else {
      process.stdout.write(`  config: ${config.source}\n\n`);
      for (const r of rows) {
        const key = r.hasApiKey ? 'key ✓' : 'key ✗';
        const acc = r.kind === 'cloudflare' ? (r.hasAccountId ? ' account ✓' : ' account ✗') : '';
        process.stdout.write(`  ${r.alias.padEnd(8)} ${r.kind.padEnd(11)} ${String(r.model ?? '').padEnd(28)} ${key}${acc}\n`);
      }
    }
    process.exit(0);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}

export function authRemoveCommand(alias: string, flags: AuthFlags): never {
  try {
    const removed = deleteCredential(alias);
    process.stdout.write((flags.json ? JSON.stringify({ ok: true, alias, removed }) : removed ? `  ✓ credencial de "${alias}" eliminada` : `  ! "${alias}" no tenía credencial guardada`) + '\n');
    process.exit(0);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}
