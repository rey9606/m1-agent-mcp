import { M1Error } from '../../core/errors';
import { parseConfig } from '../../config/config';
import {
  PROVIDER_PRESETS,
  addProvider,
  describeProvider,
  editProvider,
  getProvider,
  listProviders,
  loadGlobalConfig,
  removeProvider,
  setDefaultProvider,
} from '../../config/providerStore';
import type { ProviderDescription, ProviderPreset } from '../../config/providerStore';
import type { ProviderConfig, ProviderKind } from '../../providers/types';
import { fail } from '../output';

/** Kinds que no funcionan sin API key. */
const KEY_REQUIRED_KINDS: readonly ProviderKind[] = ['cloudflare', 'typesafe', 'openrouter'];

const PRESET_EXAMPLES: Record<string, string> = {
  cloudflare: 'm1 provider add cf --preset cloudflare --api-key <token> --account-id <account-id>',
  openrouter: 'm1 provider add or --preset openrouter --api-key <key>',
  typesafe: 'm1 provider add ts --preset typesafe --api-key <key>',
  llamacpp: 'm1 provider add local --preset llamacpp',
  custom: 'm1 provider add local2 --preset custom --base-url http://127.0.0.1:8080/v1/systemone',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function presetExample(preset: ProviderPreset): string {
  return PRESET_EXAMPLES[preset.id] ?? `m1 provider add <alias> --preset ${preset.id}`;
}

function presetRequirements(preset: ProviderPreset): string {
  const parts: string[] = [];
  if (preset.requiresApiKey) {
    parts.push(`api key${preset.apiKeyEnv ? ` (${preset.apiKeyEnv})` : ''}`);
  }
  if (preset.requiresAccountId) parts.push('account id');
  return parts.length > 0 ? parts.join(' + ') : 'nada obligatorio';
}

function keyLine(description: ProviderDescription): string {
  if (description.hasApiKey) {
    const source = description.apiKeyEnv
      ? `${description.keySource}: ${description.apiKeyEnv}`
      : description.keySource;
    return `sí (${source})`;
  }
  return KEY_REQUIRED_KINDS.includes(description.kind as ProviderKind)
    ? 'no (falta)'
    : 'no (opcional)';
}

function modelLine(description: ProviderDescription): string {
  const model = description.model ?? '—';
  return description.modelSource === 'default' ? `${model} (default del kind)` : model;
}

function declaredDefault(raw: Record<string, unknown>): string | undefined {
  const value = raw.default ?? raw.defaultProvider;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function padTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  return [header, ...rows].map((row) =>
    row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd(),
  );
}

/** `m1 provider list`: tabla ALIAS · KIND · MODELO · DEFAULT · KEY. */
export function providerListCommand(flags: { json?: boolean }): never {
  const json = Boolean(flags.json);
  try {
    const { path, exists } = loadGlobalConfig();
    const providers = listProviders();
    const defaultAlias = providers.find((provider) => provider.isDefault)?.alias;

    if (json) {
      const payload = { ok: true, configPath: path, exists, default: defaultAlias, providers };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`  config: ${path}${exists ? '' : ' (todavía no existe)'}\n\n`);
      if (providers.length === 0) {
        process.stdout.write('  (sin providers) — agregá uno con `m1 provider add cf --preset cloudflare`\n');
      } else {
        const lines = padTable(
          ['ALIAS', 'KIND', 'MODELO', 'DEFAULT', 'KEY'],
          providers.map((provider) => [
            provider.alias,
            provider.kind,
            provider.model ?? '—',
            provider.isDefault ? 'sí' : '—',
            provider.keySource,
          ]),
        );
        for (const line of lines) process.stdout.write(`  ${line}\n`);
        process.stdout.write(`\n  default: ${defaultAlias ?? '—'}\n`);
      }
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

/** `m1 provider presets`: presets disponibles con ejemplo de uso. */
export function providerPresetsCommand(flags: { json?: boolean }): never {
  const json = Boolean(flags.json);
  try {
    const presets = Object.values(PROVIDER_PRESETS);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, presets })}\n`);
    } else {
      for (const preset of presets) {
        process.stdout.write(`  ${preset.id} — ${preset.title}\n`);
        process.stdout.write(`    ${preset.description}\n`);
        const details: string[] = [`kind: ${preset.kind}`];
        if (preset.model) details.push(`modelo: ${preset.model}`);
        if (preset.baseUrl) details.push(`baseUrl: ${preset.baseUrl}`);
        details.push(`requiere: ${presetRequirements(preset)}`);
        process.stdout.write(`    ${details.join(' · ')}\n`);
        process.stdout.write(`    ejemplo: ${presetExample(preset)}\n\n`);
      }
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

/** `m1 provider show <alias>`: definición del provider sin revelar secretos. */
export function providerShowCommand(alias: string, flags: { json?: boolean }): never {
  const json = Boolean(flags.json);
  try {
    const { raw, path, exists } = loadGlobalConfig();
    const cfg = getProvider(alias);
    const description = describeProvider(alias, cfg, declaredDefault(raw));

    if (json) {
      const payload = { ok: true, configPath: path, exists, provider: description };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`  provider:   ${description.alias}\n`);
      process.stdout.write(`  kind:       ${description.kind}\n`);
      process.stdout.write(`  modelo:     ${modelLine(description)}\n`);
      process.stdout.write(`  baseUrl:    ${description.baseUrl ?? '—'}\n`);
      process.stdout.write(`  api key:    ${keyLine(description)}\n`);
      process.stdout.write(`  account id: ${description.hasAccountId ? 'configurado' : '—'}\n`);
      process.stdout.write(
        `  launch:     ${description.launch ? `sí (${description.launchCommand ?? 'llama-server'})` : 'no'}\n`,
      );
      process.stdout.write(`  default:    ${description.isDefault ? 'sí' : 'no'}\n`);
      process.stdout.write(`  config:     ${path}${exists ? '' : ' (todavía no existe)'}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

/** `m1 provider add <alias>`: crea el provider (secretos a credentials.json). */
export function providerAddCommand(
  alias: string,
  flags: {
    preset?: string;
    kind?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    accountId?: string;
    default?: boolean;
    json?: boolean;
  },
): never {
  const json = Boolean(flags.json);
  try {
    const result = addProvider(alias, flags);
    const description = describeProvider(result.alias, result.config, result.defaultProvider);

    if (json) {
      const payload = {
        ok: true,
        alias: result.alias,
        configPath: result.path,
        default: result.defaultProvider,
        apiKeyStored: result.apiKeyStored,
        changed: result.changed,
        provider: description,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`  ✓ provider "${result.alias}" agregado (${result.config.kind})\n`);
      process.stdout.write(`    modelo:  ${modelLine(description)}\n`);
      if (description.baseUrl) process.stdout.write(`    baseUrl: ${description.baseUrl}\n`);
      process.stdout.write(`    api key: ${keyLine(description)}\n`);
      process.stdout.write(
        `    default: ${result.defaultProvider === result.alias ? 'sí' : `no (${result.defaultProvider})`}\n`,
      );
      process.stdout.write(`    config:  ${result.path}\n`);
      process.stdout.write(`    → probá: m1 provider test ${result.alias}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

/** `m1 provider edit <alias>`: cambia sólo los campos provistos. */
export function providerEditCommand(
  alias: string,
  flags: {
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    apiKeyEnv?: string;
    accountId?: string;
    clearApiKey?: boolean;
    json?: boolean;
  },
): never {
  const json = Boolean(flags.json);
  try {
    const result = editProvider(alias, flags);
    const description = describeProvider(result.alias, result.config, result.defaultProvider);

    if (json) {
      const payload = {
        ok: true,
        alias: result.alias,
        configPath: result.path,
        apiKeyStored: result.apiKeyStored,
        changed: result.changed,
        provider: description,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`  ✓ provider "${result.alias}" actualizado: ${result.changed.join(', ')}\n`);
      process.stdout.write(`    modelo:  ${modelLine(description)}\n`);
      process.stdout.write(`    api key: ${keyLine(description)}\n`);
      process.stdout.write(`    default: ${description.isDefault ? 'sí' : 'no'}\n`);
      process.stdout.write(`    config:  ${result.path}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^(y|yes|s|si|sí)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** `m1 provider remove <alias>`: pide confirmación salvo `--yes`. */
export async function providerRemoveCommand(
  alias: string,
  flags: { yes?: boolean; force?: boolean; json?: boolean },
): Promise<never> {
  const json = Boolean(flags.json);
  try {
    if (!flags.yes) {
      if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new M1Error('E_USAGE', `no se puede confirmar el borrado de "${alias}" sin terminal interactiva`, {
          hint: 'para automatizar pasá --yes',
          details: { alias },
        });
      }
      const accepted = await confirm(
        `¿Borrar el provider "${alias}"${flags.force ? ' (force)' : ''}? [y/N] `,
      );
      if (!accepted) {
        throw new M1Error('E_USAGE', 'borrado cancelado', {
          hint: 'para automatizar usá --yes',
        });
      }
    }

    const result = removeProvider(alias, { force: flags.force });

    if (json) {
      const payload = {
        ok: true,
        alias: result.alias,
        removed: true,
        configPath: result.path,
        default: result.defaultProvider,
        credentialRemoved: result.credentialRemoved,
        seededMock: result.seededMock,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`  ✓ provider "${result.alias}" eliminado\n`);
      process.stdout.write(`    default: ${result.defaultProvider}\n`);
      process.stdout.write(
        `    credencial: ${result.credentialRemoved ? 'eliminada' : 'no tenía'}\n`,
      );
      if (result.seededMock) {
        process.stdout.write('    ! la config quedó vacía: sembré "mock" para que la CLI siga usable\n');
      }
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

/** `m1 provider use <alias>`: fija el provider default. */
export function providerSetDefaultCommand(alias: string, flags: { json?: boolean }): never {
  const json = Boolean(flags.json);
  try {
    const result = setDefaultProvider(alias);

    if (json) {
      const payload = {
        ok: true,
        default: result.alias,
        previous: result.previous,
        configPath: result.path,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      const previous =
        result.previous && result.previous !== result.alias ? ` (antes: ${result.previous})` : '';
      process.stdout.write(`  ✓ default: ${result.alias}${previous}\n`);
      process.stdout.write(`    config:  ${result.path}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

/**
 * `m1 provider test <alias>`: chequeos estructurales, sin red.
 * Exit 0 si no falta nada requerido; 2 si falta algo.
 */
export async function providerTestCommand(alias: string, flags: { json?: boolean }): Promise<never> {
  const json = Boolean(flags.json);
  try {
    const { raw, path } = loadGlobalConfig();
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    try {
      parseConfig(raw);
      checks.push({ name: 'config', ok: true, detail: `config global válida (${path})` });
    } catch (error) {
      checks.push({ name: 'config', ok: false, detail: errorText(error) });
    }

    let cfg: ProviderConfig | undefined;
    try {
      cfg = getProvider(alias);
      checks.push({ name: 'provider', ok: true, detail: `${cfg.kind} definido` });
    } catch (error) {
      if (error instanceof M1Error && error.code === 'E_INPUT') throw error;
      checks.push({ name: 'provider', ok: false, detail: errorText(error) });
    }

    if (cfg) {
      const description = describeProvider(alias, cfg, declaredDefault(raw));

      if (!description.baseUrl) {
        checks.push({
          name: 'baseUrl',
          ok: cfg.kind !== 'systemone',
          detail:
            cfg.kind === 'systemone'
              ? 'falta baseUrl: pasá --base-url http://127.0.0.1:9931/v1/systemone'
              : 'no requerida para este kind',
        });
      } else if (!isValidUrl(description.baseUrl)) {
        checks.push({ name: 'baseUrl', ok: false, detail: `URL inválida: ${description.baseUrl}` });
      } else {
        checks.push({ name: 'baseUrl', ok: true, detail: description.baseUrl });
      }

      const requiresKey = KEY_REQUIRED_KINDS.includes(cfg.kind);
      if (description.hasApiKey) {
        checks.push({
          name: 'apiKey',
          ok: true,
          detail: `presente (${description.keySource}${description.apiKeyEnv ? `: ${description.apiKeyEnv}` : ''})`,
        });
      } else if (requiresKey) {
        checks.push({
          name: 'apiKey',
          ok: false,
          detail: `falta la API key: m1 provider edit ${alias} --api-key <key> o definí ${description.apiKeyEnv ?? 'la variable de entorno'}`,
        });
      } else {
        checks.push({ name: 'apiKey', ok: true, detail: 'opcional para este kind' });
      }

      if (cfg.kind === 'cloudflare') {
        checks.push({
          name: 'accountId',
          ok: description.hasAccountId,
          detail: description.hasAccountId
            ? 'configurado'
            : `falta el account id: m1 provider edit ${alias} --account-id <id> o definí CLOUDFLARE_ACCOUNT_ID`,
        });
      } else {
        checks.push({ name: 'accountId', ok: true, detail: 'no aplica' });
      }

      if (cfg.launch) {
        checks.push({
          name: 'launch',
          ok: true,
          detail: `configurado (${description.launchCommand ?? 'llama-server'}); el modelo local se valida al correr: m1 local status --provider ${alias}`,
        });
      } else {
        checks.push({ name: 'launch', ok: true, detail: 'sin launch: se espera el servidor ya corriendo' });
      }
    }

    const ok = checks.every((check) => check.ok);
    const kind = cfg?.kind ?? 'desconocido';

    if (json) {
      process.stdout.write(`${JSON.stringify({ ok, alias, kind, checks })}\n`);
    } else {
      process.stdout.write(`  provider: ${alias} (${kind})\n\n`);
      for (const check of checks) {
        process.stdout.write(`  ${check.ok ? '✓' : '✗'} ${check.name.padEnd(10)} ${check.detail ?? ''}\n`);
      }
      process.stdout.write('\n');
      if (ok) {
        process.stdout.write('  ✓ chequeos estructurales OK (sin red)\n');
      } else {
        process.stdout.write(`  ✗ falta configurar algo: m1 provider show ${alias}\n`);
      }
    }
    process.exit(ok ? 0 : 2);
  } catch (error) {
    fail(error, json);
  }
}