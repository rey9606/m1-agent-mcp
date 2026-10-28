import { loadConfig, resolveProvider } from '../../config/config';
import type { AppConfig } from '../../config/config';
import { M1Error } from '../../core/errors';
import {
  buildLaunchSpec,
  ensureLocalEndpoint,
  formatCommand,
  localStatus,
  stopLocalServer,
} from '../../local/lifecycle';
import type { ProviderConfig } from '../../providers/types';
import { fail } from '../output';

export interface LocalFlags {
  provider?: string;
  config?: string;
  json?: boolean;
}

interface ResolvedLocal {
  alias: string;
  cfg: ProviderConfig;
  /** Default no-local reemplazado por el único provider local de la config. */
  assumedFrom?: string;
}

/** Aliases que pueden administrarse localmente (systemone + launch). */
function localAliases(config: AppConfig): string[] {
  return Object.entries(config.providers)
    .filter(([, provider]) => provider.kind === 'systemone' && provider.launch !== undefined)
    .map(([alias]) => alias);
}

function resolveLocalConfig(flags: LocalFlags, action: string): ResolvedLocal {
  const config = loadConfig({ explicit: flags.config });
  const locals = localAliases(config);

  if (!flags.provider) {
    const defaultProvider = config.providers[config.defaultProvider];
    if (defaultProvider?.kind !== 'systemone' && locals.length === 1) {
      // Un solo provider local: es el que el usuario quiere administrar aunque
      // el default de la config sea cloud (caso típico: ejecutar `m1 local status`
      // desde cualquier carpeta).
      const only = locals[0]!;
      return { alias: only, cfg: config.providers[only]!, assumedFrom: config.defaultProvider };
    }
  }

  const { alias, config: cfg } = resolveProvider(config, flags.provider);
  if (cfg.kind !== 'systemone') {
    const hint =
      locals.length > 0
        ? `"${alias}" es kind ${cfg.kind}; este comando necesita uno local. ` +
          `Probá: m1 local ${action} --provider ${locals[0]}` +
          (locals.length > 1 ? ` (locales: ${locals.join(', ')})` : '')
        : 'no hay providers locales (kind "systemone" con "launch") en la config. ' +
          'Agregá uno o mirá la sección "Modelo local" del README.';
    throw new M1Error('E_CONFIG', `provider "${alias}" no es un endpoint local (kind: ${cfg.kind})`, {
      hint,
    });
  }
  return { alias, cfg };
}

/** Avisa por stderr cuando se usó un alias local distinto del default. */
function announceAssumption(resolved: ResolvedLocal, flags: LocalFlags): void {
  if (flags.json || resolved.assumedFrom === undefined) return;
  process.stderr.write(
    `  … el default "${resolved.assumedFrom}" no es local; uso "${resolved.alias}" (único provider local)\n`,
  );
}

export async function localStartCommand(flags: LocalFlags): Promise<never> {
  try {
    const resolved = resolveLocalConfig(flags, 'start');
    announceAssumption(resolved, flags);
    const { alias, cfg } = resolved;
    const result = await ensureLocalEndpoint({
      alias,
      cfg,
      autoStart: 'always',
      interactive: false,
      onStatus: (line) => {
        if (!flags.json) process.stderr.write(`  … ${line}\n`);
      },
    });

    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, alias, ...result }) + '\n');
    } else {
      process.stdout.write(`  ✓ ${alias}   running   ${result.baseUrl}\n`);
      if (result.pid !== undefined) process.stdout.write(`    pid: ${result.pid}\n`);
      if (result.logPath) process.stdout.write(`    log: ${result.logPath}\n`);
      process.stdout.write(
        `    queda corriendo: cerralo desde su consola o con \`m1 local stop --provider ${alias}\`\n`,
      );
    }
    process.exit(0);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}

export async function localStatusCommand(flags: LocalFlags): Promise<never> {
  try {
    const resolved = resolveLocalConfig(flags, 'status');
    announceAssumption(resolved, flags);
    const { alias, cfg } = resolved;
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
        process.stdout.write(`    levantalo con: m1 local start --provider ${alias}\n`);
      }
    }
    process.exit(status.state === 'running' ? 0 : 2);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}

export function localStopCommand(flags: LocalFlags): never {
  try {
    const resolved = resolveLocalConfig(flags, 'stop');
    announceAssumption(resolved, flags);
    const { alias } = resolved;
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