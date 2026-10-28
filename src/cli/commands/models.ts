import { readFileSync, writeFileSync } from 'node:fs';

import { M1Error } from '../../core/errors';
import { findConfigPath, loadConfig, resolveProvider } from '../../config/config';
import { resolveSecrets } from '../../config/credentials';
import { clearPreferredModel, loadPreferences, savePreferredModel } from '../../config/preferences';
import { capabilitiesFor, isValidModelId, listModels, staticModelsFor } from '../../providers/models';
import { resolveEffectiveModel } from '../../providers/registry';
import type { ModelInfo } from '../../providers/models';
import type { EffectiveModel } from '../../providers/registry';
import type { ProviderConfig, ProviderKind } from '../../providers/types';
import { fail } from '../output';

export interface ModelsFlags {
  provider?: string;
  search?: string;
  json?: boolean;
  config?: string;
}

export interface ModelShowFlags {
  provider?: string;
  json?: boolean;
  config?: string;
}

export interface ModelUseFlags {
  provider?: string;
  project?: boolean;
  json?: boolean;
  config?: string;
}

export interface ModelResetFlags {
  provider?: string;
  json?: boolean;
  config?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Target {
  alias: string;
  providerCfg: ProviderConfig;
  effective: EffectiveModel;
  warnings: string[];
}

/** Carga config + preferencias y calcula el modelo efectivo del provider. */
function resolveTarget(flags: { provider?: string; config?: string }): Target {
  const config = loadConfig({ explicit: flags.config });
  const { alias, config: providerCfg } = resolveProvider(config, flags.provider);
  const warnings: string[] = [];
  const preferences = loadPreferences(warnings);
  const effective = resolveEffectiveModel({
    cfg: providerCfg,
    preferredModel: preferences.models?.[alias],
  });
  return { alias, providerCfg, effective, warnings };
}

function resolveSecretsSafe(
  alias: string,
  providerCfg: ProviderConfig,
  warnings: string[],
): { apiKey?: string; accountId?: string } {
  try {
    return resolveSecrets(alias, providerCfg);
  } catch (error) {
    warnings.push(`no se pudieron leer las credenciales: ${(error as Error).message}`);
    return {};
  }
}

function sameModel(kind: ProviderKind, a: string, b: string): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/^@cf\/cloudflare\//, '');
  if (kind === 'cloudflare') return normalize(a) === normalize(b);
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function formatPrice(price: number | undefined): string {
  return price === undefined ? '—' : `$${price}/M`;
}

function printModels(target: Target, models: ModelInfo[]): void {
  const { alias, providerCfg, effective } = target;
  process.stdout.write(`  provider: ${alias} (${providerCfg.kind})\n`);
  process.stdout.write(`  modelo:   ${effective.model} (${effective.source})\n\n`);
  if (models.length === 0) {
    process.stdout.write('  (sin modelos)\n');
    return;
  }

  const rows = models.map((model) => [
    sameModel(providerCfg.kind, model.id, effective.model) ? '*' : '',
    model.id,
    model.contextWindow !== undefined ? String(model.contextWindow) : '—',
    model.capabilities.images ? 'sí' : 'no',
    formatPrice(model.inputPricePerMillion),
    model.source,
  ]);
  const header = ['', 'id', 'ctx', 'vision', 'precio', 'source'];
  const table = [header, ...rows];
  const widths = header.map((_, index) => Math.max(...table.map((row) => row[index]!.length)));

  for (const row of table) {
    const line = row.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd();
    process.stdout.write(`  ${line}\n`);
  }
}

function knownIdsHint(kind: ProviderKind): string {
  const ids = staticModelsFor(kind).map((model) => model.id);
  if (kind === 'systemone') {
    return 'cualquier id que exponga el endpoint compatible';
  }
  return ids.join(', ');
}

function writeProjectModel(explicit: string | undefined, alias: string, model: string): string {
  const path = findConfigPath(explicit);
  if (!path) {
    throw new M1Error('E_CONFIG', 'no hay m1.config.json para guardar el modelo con --project', {
      hint: 'creá m1.config.json en el cwd (o pasá -c <file>)',
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new M1Error('E_CONFIG', `no se pudo leer la config: ${path}`, {
      hint: 'verificá que sea JSON válido',
      cause: error,
    });
  }
  if (!isRecord(raw)) {
    throw new M1Error('E_CONFIG', `la config no es un objeto JSON: ${path}`);
  }
  const providers = raw.providers;
  if (!isRecord(providers)) {
    throw new M1Error('E_CONFIG', `la config no tiene "providers": ${path}`, {
      hint: 'ver m1.config.example.json',
    });
  }
  const provider = providers[alias];
  if (!isRecord(provider)) {
    throw new M1Error('E_CONFIG', `provider "${alias}" no existe en ${path}`, {
      hint: `aliases disponibles: ${Object.keys(providers).join(', ')}`,
    });
  }

  provider.model = model;
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  return path;
}

export async function modelsCommand(flags: ModelsFlags): Promise<never> {
  const json = Boolean(flags.json);
  try {
    const target = resolveTarget(flags);
    const secrets = resolveSecretsSafe(target.alias, target.providerCfg, target.warnings);
    const { models, warnings } = await listModels({
      kind: target.providerCfg.kind,
      model: target.effective.model,
      baseUrl: target.providerCfg.baseUrl,
      accountId: target.providerCfg.accountId ?? secrets.accountId,
      apiKey: target.providerCfg.apiKey ?? secrets.apiKey,
      search: flags.search,
      timeoutMs: target.providerCfg.timeoutMs,
    });
    warnings.unshift(...target.warnings);

    if (json) {
      const payload = {
        ok: true,
        provider: target.alias,
        model: target.effective.model,
        models,
        warnings,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      for (const warning of warnings) process.stderr.write(`  ! ${warning}\n`);
      printModels(target, models);
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

export function modelShowCommand(flags: ModelShowFlags): never {
  const json = Boolean(flags.json);
  try {
    const target = resolveTarget(flags);
    const capabilities = capabilitiesFor(target.providerCfg.kind, target.effective.model);

    if (json) {
      const payload = {
        ok: true,
        provider: target.alias,
        kind: target.providerCfg.kind,
        model: target.effective.model,
        source: target.effective.source,
        capabilities: capabilities ?? null,
        warnings: target.warnings,
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      for (const warning of target.warnings) process.stderr.write(`  ! ${warning}\n`);
      process.stdout.write(`  provider: ${target.alias} (${target.providerCfg.kind})\n`);
      process.stdout.write(`  modelo:   ${target.effective.model}\n`);
      process.stdout.write(`  fuente:   ${target.effective.source}\n`);
      if (!capabilities) {
        process.stdout.write('  vision:   desconocido\n');
      } else {
        process.stdout.write(`  vision:   ${capabilities.images ? 'sí' : 'no'}\n`);
        process.stdout.write(`  audio:    ${capabilities.audio ? 'sí' : 'no'}\n`);
        process.stdout.write(`  video:    ${capabilities.video ? 'sí' : 'no'}\n`);
      }
    }
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

export function modelUseCommand(id: string, flags: ModelUseFlags): never {
  const json = Boolean(flags.json);
  try {
    const config = loadConfig({ explicit: flags.config });
    const { alias, config: providerCfg } = resolveProvider(config, flags.provider);

    if (!isValidModelId(providerCfg.kind, id)) {
      throw new M1Error('E_USAGE', `modelo inválido para "${alias}" (${providerCfg.kind}): ${id}`, {
        hint: `ids válidos: ${knownIdsHint(providerCfg.kind)}`,
        details: { provider: alias, kind: providerCfg.kind, model: id },
      });
    }

    if (flags.project) {
      const path = writeProjectModel(flags.config, alias, id);
      const payload = { ok: true, provider: alias, model: id, stored: 'project', path };
      process.stdout.write(
        (json ? JSON.stringify(payload) : `  ✓ "${alias}" usará "${id}" (guardado en ${path})`) + '\n',
      );
      process.exit(0);
    }

    savePreferredModel(alias, id);
    const payload = { ok: true, provider: alias, model: id, stored: 'preference' };
    process.stdout.write(
      (json ? JSON.stringify(payload) : `  ✓ "${alias}" usará "${id}" (preferencia de usuario)`) + '\n',
    );
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}

export function modelResetCommand(flags: ModelResetFlags): never {
  const json = Boolean(flags.json);
  try {
    const config = loadConfig({ explicit: flags.config });
    const { alias } = resolveProvider(config, flags.provider);
    const removed = clearPreferredModel(alias);
    const payload = { ok: true, provider: alias, removed };
    process.stdout.write(
      (json
        ? JSON.stringify(payload)
        : removed
          ? `  ✓ preferencia de "${alias}" eliminada`
          : `  ! "${alias}" no tenía preferencia guardada`) + '\n',
    );
    process.exit(0);
  } catch (error) {
    fail(error, json);
  }
}
