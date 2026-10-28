import { loadConfig, resolveProvider } from '../../config/config';
import { M1Error } from '../../core/errors';
import { buildLaunchSpec, formatCommand, localStatus, stopLocalServer } from '../../local/lifecycle';
import type { ProviderConfig } from '../../providers/types';
import { fail } from '../output';

export interface LocalFlags {
  provider?: string;
  config?: string;
  json?: boolean;
}

function resolveLocalConfig(flags: LocalFlags): { alias: string; cfg: ProviderConfig } {
  const config = loadConfig({ explicit: flags.config });
  const { alias, config: cfg } = resolveProvider(config, flags.provider);
  if (cfg.kind !== 'systemone') {
    throw new M1Error('E_CONFIG', `provider "${alias}" no es un endpoint local (kind: ${cfg.kind})`, {
      hint: 'usá --provider con un alias kind "systemone"',
    });
  }
  return { alias, cfg };
}

export async function localStatusCommand(flags: LocalFlags): Promise<never> {
  try {
    const { alias, cfg } = resolveLocalConfig(flags);
    const status = await localStatus(alias, cfg);

    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, ...status }) + '\n');
    } else {
      const icon = status.state === 'running' ? '✓' : status.state === 'starting' ? '…' : '✗';
      process.stdout.write(`  ${icon} ${alias.padEnd(8)} ${status.state.padEnd(9)} ${status.baseUrl}\n`);
      if (status.logPath) process.stdout.write(`    log: ${status.logPath}\n`);
      if (status.state !== 'running' && cfg.launch) {
        const spec = buildLaunchSpec(cfg, {
          port: cfg.launch.port ?? status.port,
          host: new URL(status.baseUrl).hostname,
        });
        process.stdout.write(`    → ${formatCommand(spec)}\n`);
      }
    }
    process.exit(status.state === 'running' ? 0 : 2);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}

export function localStopCommand(flags: LocalFlags): never {
  try {
    const { alias } = resolveLocalConfig(flags);
    const result = stopLocalServer(alias);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: result.stopped, alias, ...result }) + '\n');
    } else if (result.stopped) {
      process.stdout.write(`  ✓ ${alias}: servidor detenido (pid ${result.pid})\n`);
    } else {
      process.stdout.write(`  ○ ${alias}: ${result.reason}\n`);
    }
    process.exit(0);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}
