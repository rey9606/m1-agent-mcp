#!/usr/bin/env tsx
/**
 * Smoke test contra el proveedor real.
 *
 *   pnpm exec tsx scripts/smoke.ts [--provider cf] [--model ...] [--image path]
 *
 * Flujo:
 *  1. Carga .env + config y resuelve el provider (default: cf).
 *  2. Sin credenciales NO hace red: imprime qué falta y sale con código 2.
 *  3. Una llamada mínima (1 noul + 1 score de 3 niveles) con timeout de 30s.
 *  4. Si la llamada funciona, corre la receta copy-checker completa.
 *
 * Nunca imprime la API key.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { loadConfig, loadDotEnv, resolveProvider } from '../src/config/config';
import { resolveSecrets } from '../src/config/credentials';
import { runRecipe } from '../src/core/engine';
import { M1Error } from '../src/core/errors';
import { validateRecipe } from '../src/core/validate';
import { loadImage } from '../src/intake/images';
import { createProvider, defaultModelFor } from '../src/providers/registry';
import { renderCompact } from '../src/render/compact';
import type {
  DecisionProvider,
  DecisionRequest,
  ImageInput,
  ProviderConfig,
} from '../src/providers/types';
import type { AppConfig } from '../src/config/config';

const TIMEOUT_MS = 30_000;
const COPY_RECIPE_PATH = resolve(process.cwd(), 'examples', 'copy-checker.json');

const SMOKE_COPY = [
  'Probá M1 gratis y convertí tus ideas en decisiones en 2 minutos.',
  'Escribí tu idea, recibí un plan claro y empezá hoy mismo.',
].join(' ');

const SMOKE_BRIEF = 'Audiencia: equipos de producto. Tono: directo y cálido.';

const CLOUDFLARE_CREDENTIALS_MESSAGE =
  'faltan credenciales: definí CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN en .env';

interface Flags {
  provider?: string;
  model?: string;
  image?: string;
  help?: boolean;
}

function usage(): string {
  return [
    'Uso: pnpm exec tsx scripts/smoke.ts [opciones]',
    '',
    'Opciones:',
    '  --provider <alias>  alias del provider en la config (default: cf)',
    '  --model <modelo>    override del modelo',
    '  --image <ruta>      imagen PNG/JPEG/WebP para adjuntar a la llamada mínima',
    '  --help              muestra esta ayuda',
  ].join('\n');
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  const readValue = (arg: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) return [inline, index];
    const next = argv[index + 1];
    if (next === undefined) {
      console.error(`falta el valor de ${arg}`);
      process.exit(2);
    }
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const key = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;

    if (key === '--help' || key === '-h') {
      flags.help = true;
      continue;
    }

    let value: string;
    switch (key) {
      case '--provider':
        [value, i] = readValue(key, inline, i);
        flags.provider = value;
        break;
      case '--model':
        [value, i] = readValue(key, inline, i);
        flags.model = value;
        break;
      case '--image':
        [value, i] = readValue(key, inline, i);
        flags.image = value;
        break;
      default:
        console.error(`argumento desconocido: ${arg}\n\n${usage()}`);
        process.exit(2);
    }
  }

  return flags;
}

/**
 * Con la config builtin (sin m1.config.json) el default es `mock`, que no sirve
 * para un smoke real: apuntamos a `cf` y, si no está configurado, usamos la
 * config mínima de Cloudflare. Así el chequeo de credenciales es el primero.
 */
function resolveTarget(
  config: AppConfig,
  providerFlag: string | undefined,
  model: string | undefined,
): { alias: string; config: ProviderConfig } {
  const alias = providerFlag ?? (config.source === '(builtin)' ? 'cf' : config.defaultProvider);

  if (config.providers[alias]) return resolveProvider(config, alias, { model });

  if (alias === 'cf') {
    const cfg: ProviderConfig = { kind: 'cloudflare' };
    if (model) cfg.model = model;
    return { alias, config: cfg };
  }

  // Lanza E_CONFIG con los aliases disponibles.
  return resolveProvider(config, alias, { model });
}

function printError(error: unknown): never {
  if (error instanceof M1Error) {
    console.error(`error: ${error.code}`);
    console.error(`mensaje: ${error.message}`);
    if (error.hint) console.error(`hint: ${error.hint}`);
  } else {
    console.error('error: E_INTERNAL');
    console.error(`mensaje: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(2);
}

function checkCredentials(alias: string, cfg: ProviderConfig): { provider: DecisionProvider; model: string; providerConfig: ProviderConfig } {
  const secrets = resolveSecrets(alias, cfg);
  const merged: ProviderConfig = {
    ...cfg,
    apiKey: cfg.apiKey ?? secrets.apiKey,
    accountId: cfg.accountId ?? secrets.accountId,
  };

  if (merged.kind === 'cloudflare') {
    if (!merged.accountId || !merged.apiKey) {
      console.error(CLOUDFLARE_CREDENTIALS_MESSAGE);
      process.exit(2);
    }
  } else if (merged.kind !== 'mock' && !merged.apiKey) {
    console.error(
      `faltan credenciales: definí ${merged.apiKeyEnv ?? 'la API key'} del provider "${alias}" en .env`,
    );
    process.exit(2);
  }

  const model = merged.model ?? defaultModelFor(merged.kind);
  return { provider: createProvider(alias, merged), model, providerConfig: merged };
}

async function loadImageInput(imageFlag: string | undefined): Promise<ImageInput | undefined> {
  if (!imageFlag) return undefined;
  const path = isAbsolute(imageFlag) ? imageFlag : resolve(process.cwd(), imageFlag);
  const loaded = await loadImage(path);
  return { content_type: loaded.content_type, base64: loaded.base64 };
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }

  loadDotEnv();
  const config = loadConfig();
  const target = resolveTarget(config, flags.provider, flags.model);
  const { provider, model } = checkCredentials(target.alias, target.config);

  const image = await loadImageInput(flags.image);

  // -------------------------------------------------------------------------
  // 1. Llamada mínima real
  // -------------------------------------------------------------------------
  const request: DecisionRequest = {
    model,
    state: {
      tarea: 'Smoke test de M1: verificá que el contrato de decisión responde completo.',
      contexto: 'Llamada mínima de diagnóstico; no hay usuario final.',
    },
    questions: {
      smoke_noul: {
        type: 'noul',
        instructions: '¿La llamada de smoke devolvió una respuesta completa?',
      },
      smoke_score: {
        type: 'score',
        instructions: '¿Qué tan confiable es esta llamada de smoke?',
        criteria: ['Baja', 'Media', 'Alta'],
      },
    },
  };
  if (image) request.images = [image];

  console.log(`provider: ${target.alias} (${target.config.kind})`);
  console.log(`modelo: ${model}`);
  if (image) console.log(`imagen: ${image.content_type} (${image.base64.length} chars base64)`);

  const startedAt = Date.now();
  const response = await provider.evaluate(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const latencyMs = Date.now() - startedAt;

  console.log(`latencia: ${latencyMs}ms`);
  console.log(`usage: ${JSON.stringify(response.usage ?? {})}`);
  console.log('respuestas:');
  console.log(JSON.stringify(response.answers, null, 2));

  // -------------------------------------------------------------------------
  // 2. Receta real completa (copy-checker)
  // -------------------------------------------------------------------------
  console.log('\ncopy-checker:');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(COPY_RECIPE_PATH, 'utf8')) as unknown;
  } catch (error) {
    throw new M1Error('E_INPUT', `no se pudo leer la receta: ${COPY_RECIPE_PATH}`, {
      hint: 'ejecutá el smoke desde la raíz del proyecto',
      cause: error,
    });
  }

  const { recipe, warnings } = validateRecipe(raw, {
    filePath: COPY_RECIPE_PATH,
    defaultId: 'copy-checker',
  });
  for (const warning of warnings) console.error(`  ! ${warning}`);

  const result = await runRecipe({
    recipe,
    input: { copy: SMOKE_COPY, brief: SMOKE_BRIEF },
    deps: {
      provider,
      providerName: target.alias,
      model,
      timeoutMs: TIMEOUT_MS,
    },
    options: { timeoutMs: TIMEOUT_MS },
  });

  console.log(renderCompact(result));
  if (result.issues.length > 0) console.log(JSON.stringify(result.issues, null, 2));
}

try {
  await main();
} catch (error) {
  printError(error);
}
