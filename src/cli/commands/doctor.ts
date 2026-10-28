import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../config/config';
import { resolveSecrets } from '../../config/credentials';
import { fail } from '../output';

export interface DoctorFlags {
  json?: boolean;
  config?: string;
}

export function doctorCommand(flags: DoctorFlags): never {
  try {
    const config = loadConfig({ explicit: flags.config });
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({ name: 'node', ok: major >= 22, detail: `v${process.versions.node} (requiere >=22)` });
    checks.push({ name: 'config', ok: Boolean(config.source && config.source !== '(builtin)'), detail: config.source ?? '(builtin)' });
    checks.push({ name: '.env', ok: existsSync(join(process.cwd(), '.env')), detail: existsSync(join(process.cwd(), '.env')) ? '.env presente' : 'sin .env (opcional)' });
    checks.push({ name: 'examples', ok: existsSync(join(process.cwd(), 'examples')), detail: 'examples/' });

    const providers = Object.entries(config.providers).map(([alias, cfg]) => {
      let ok = true;
      let detail = cfg.kind;
      try {
        const s = resolveSecrets(alias, cfg);
        if (cfg.kind === 'cloudflare') ok = Boolean(s.apiKey && s.accountId);
        else if (cfg.kind === 'typesafe') ok = Boolean(s.apiKey);
        else if (cfg.kind === 'systemone') ok = Boolean(cfg.baseUrl);
        else ok = true;
        detail = `${cfg.kind}${cfg.model ? ` · ${cfg.model}` : ''}`;
      } catch (e) {
        ok = false;
        detail = (e as Error).message;
      }
      return { alias, ok, detail };
    });

    const usable = providers.filter((p) => p.ok).length;
    const ready = checks.find((c) => c.name === 'node')?.ok && usable > 0;

    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: ready, checks, providers }) + '\n');
    } else {
      for (const c of checks) process.stdout.write(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(10)} ${c.detail}\n`);
      process.stdout.write('\n');
      for (const p of providers) process.stdout.write(`  ${p.ok ? '✓' : '✗'} ${p.alias.padEnd(8)} ${p.detail}\n`);
      if (!ready) process.stdout.write('\n  → configurá un provider: m1 auth set cf --token ... --account-id ...\n');
    }
    process.exit(ready ? 0 : 2);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}
