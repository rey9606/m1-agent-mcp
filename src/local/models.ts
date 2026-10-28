import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ProviderConfig } from '../providers/types';

/**
 * Resolución del modelo de un `llama-server` a partir de `provider.model`.
 *
 * Acepta un repo de HuggingFace (`org/repo[:quant]`, que `llama-server` baja y
 * cachea con `-hf`) o la ruta a un `.gguf` local. Los args explícitos de
 * `launch.args` (`-m`, `--model`, `-hf`, `--hf-repo`) siempre mandan: en ese
 * caso no se agrega nada, para no duplicar flags.
 *
 * Este módulo NO importa `lifecycle.ts` (lifecycle importa a éste): el comando
 * sugerido se arma acá a mano.
 */

/** Raíz de la caché de HuggingFace (`<dir>/hub`). */
export function hfCacheDir(): string {
  const override = process.env.M1_HF_CACHE_DIR?.trim();
  if (override) return override;
  const hfHome = process.env.HF_HOME?.trim();
  if (hfHome) return join(hfHome, 'hub');
  return join(homedir(), '.cache', 'huggingface', 'hub');
}

/** Flags de `launch.args` que ya eligen modelo: si están, no inyectamos otros. */
const EXPLICIT_MODEL_FLAGS = ['-m', '--model', '-hf', '--hf-repo'] as const;

export function hasExplicitModelArgs(args: readonly string[] | undefined): boolean {
  if (!args || args.length === 0) return false;
  return args.some((arg) =>
    EXPLICIT_MODEL_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

export interface HfSpec {
  /** `org/repo`. */
  repo: string;
  /** Cuantización (`Q4_K_M`, `Q8_0`, …) si vino después de `:`. */
  quant?: string;
}

/** Cada mitad de `org/repo`: sin separadores de path ni puntos suspensivos. */
function isHfSegment(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
}

/**
 * Parsea `org/repo` o `org/repo:QUANT`.
 *
 * Devuelve `undefined` para rutas de archivo (`x.gguf`, `./x.gguf`,
 * `C:\x.gguf`, `/abs/x.gguf`, `org/repo/x.gguf`) y para cualquier cosa que no
 * sea exactamente `org/repo[:quant]`.
 */
export function parseHfSpec(model: string): HfSpec | undefined {
  if (typeof model !== 'string') return undefined;
  const value = model.trim();
  if (value === '') return undefined;
  if (/\.gguf$/i.test(value)) return undefined;
  if (value.includes('\\')) return undefined;
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('~')) return undefined;
  // Unidad de Windows (`C:`) o cualquier otro `X:` al principio.
  if (/^[A-Za-z]:/.test(value)) return undefined;

  const colon = value.indexOf(':');
  const repoPart = colon === -1 ? value : value.slice(0, colon);
  let quant: string | undefined;
  if (colon !== -1) {
    quant = value.slice(colon + 1);
    if (quant === '' || value.indexOf(':', colon + 1) !== -1) return undefined;
    if (!/^[A-Za-z0-9._-]+$/.test(quant)) return undefined;
  }

  const parts = repoPart.split('/');
  if (parts.length !== 2) return undefined;
  const [org, repo] = parts as [string, string];
  if (!isHfSegment(org) || !isHfSegment(repo)) return undefined;
  return quant === undefined ? { repo: repoPart } : { repo: repoPart, quant };
}

/** Nombre del directorio de la caché: `models--org--repo`. */
export function hfRepoDir(spec: { repo: string }): string {
  return `models--${spec.repo.replaceAll('/', '--')}`;
}

/** Directorio de la caché de HuggingFace para un repo. */
export function hfRepoPath(spec: { repo: string }): string {
  return join(hfCacheDir(), hfRepoDir(spec));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function listGgufs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => /\.gguf$/i.test(name));
  } catch {
    return [];
  }
}

/**
 * Primer `.gguf` cacheado del repo (prefiere el que coincide con `quant` y
 * descarta los `mmproj-*`). `undefined` si el repo no está descargado.
 */
export function findCachedGguf(spec: HfSpec): string | undefined {
  const snapshots = join(hfRepoPath(spec), 'snapshots');
  let revisions: string[];
  try {
    revisions = readdirSync(snapshots, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }

  const files: string[] = [];
  for (const revision of revisions.sort().reverse()) {
    for (const name of listGgufs(join(snapshots, revision))) {
      files.push(join(snapshots, revision, name));
    }
  }
  if (files.length === 0) return undefined;

  if (spec.quant) {
    const pattern = new RegExp(`(^|[-_.])${escapeRegExp(spec.quant)}([-_.]|$|\\.gguf$)`, 'i');
    const match = files.find((file) => pattern.test(basename(file)));
    if (match) return match;
  }
  return files.find((file) => !/^mmproj/i.test(basename(file))) ?? files[0];
}

export interface HfModelSource {
  mode: 'hf';
  repo: string;
  quant?: string;
  cached: boolean;
  cachePath?: string;
}

export interface FileModelSource {
  mode: 'file';
  path: string;
  exists: boolean;
}

export interface NoModelSource {
  mode: 'none';
}

export type ModelSource = HfModelSource | FileModelSource | NoModelSource;

/**
 * De dónde sale el modelo del servidor local.
 *
 * - `none`: `launch.args` ya trae el modelo, no hay `model`, o el `model` no es
 *   un repo de HF ni un `.gguf` (p. ej. un alias cualquiera).
 */
export function resolveModelSource(cfg: ProviderConfig): ModelSource {
  if (hasExplicitModelArgs(cfg.launch?.args)) return { mode: 'none' };

  const model = cfg.model?.trim();
  if (!model) return { mode: 'none' };

  const spec = parseHfSpec(model);
  if (spec) {
    const cachePath = findCachedGguf(spec);
    return {
      mode: 'hf',
      repo: spec.repo,
      ...(spec.quant !== undefined ? { quant: spec.quant } : {}),
      cached: cachePath !== undefined,
      ...(cachePath !== undefined ? { cachePath } : {}),
    };
  }

  if (/\.gguf$/i.test(model) || existsSync(model)) {
    return { mode: 'file', path: model, exists: existsSync(model) };
  }

  return { mode: 'none' };
}

/** Args que eligen el modelo en `llama-server` (vacíos para `none`). */
export function llamaModelArgs(source: ModelSource): string[] {
  if (source.mode === 'hf') {
    return ['-hf', source.quant ? `${source.repo}:${source.quant}` : source.repo];
  }
  if (source.mode === 'file') return ['-m', source.path];
  return [];
}

/** Etiqueta legible del modelo (`org/repo:quant`, la ruta o `undefined`). */
export function modelLabel(source: ModelSource): string | undefined {
  if (source.mode === 'hf') return source.quant ? `${source.repo}:${source.quant}` : source.repo;
  if (source.mode === 'file') return source.path;
  return undefined;
}

function quoteArg(value: string): string {
  return /[\s"']/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function baseUrlPort(baseUrl: string | undefined): number | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return undefined;
  }
}

function baseUrlHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
}

function hasFlagArg(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export interface LlamaModelPlan {
  source: ModelSource;
  /** `true` si el repo es de HF y todavía no hay `.gguf` en la caché. */
  needsDownload: boolean;
  /** Comando sugerido para mostrar al usuario. */
  hint: string;
}

/**
 * Plan del modelo para un provider: fuente, si hace falta descargar y el
 * comando sugerido (`llama-server -hf … --port …`).
 *
 * No arranca nada ni descarga: sólo describe.
 */
export function planLlamaModel(cfg: ProviderConfig): LlamaModelPlan {
  const source = resolveModelSource(cfg);
  const command = cfg.launch?.command ?? 'llama-server';
  const port = cfg.launch?.port ?? baseUrlPort(cfg.baseUrl);
  const host = baseUrlHost(cfg.baseUrl);

  const args = (cfg.launch?.args ?? []).map((arg) =>
    arg
      .replaceAll('{port}', port !== undefined ? String(port) : '{port}')
      .replaceAll('{host}', host ?? '{host}')
      .replaceAll('{model}', cfg.model ?? '')
      .replaceAll('{baseUrl}', cfg.baseUrl ?? ''),
  );

  if (!hasExplicitModelArgs(args)) args.push(...llamaModelArgs(source));
  if (cfg.launch?.mmproj && !hasFlagArg(args, '--mmproj')) {
    args.push('--mmproj', cfg.launch.mmproj);
  }
  if (port !== undefined && !hasFlagArg(args, '--port')) {
    args.push('--port', String(port));
  }
  if (cfg.model && !hasFlagArg(args, '--alias')) args.push('--alias', cfg.model);

  return {
    source,
    needsDownload: source.mode === 'hf' && !source.cached,
    hint: [command, ...args].map(quoteArg).join(' '),
  };
}