import { M1Error } from '../core/errors';
import type { ProviderKind } from './types';

/** Capacidades conocidas de un modelo. `images` es la única que el motor usa para bloquear. */
export interface ModelCapabilities {
  images: boolean;
  audio?: boolean;
  video?: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  inputPricePerMillion?: number;
  capabilities: ModelCapabilities;
  source: 'api' | 'static';
  description?: string;
}

export const CLOUDFLARE_MODELS_BASE = 'https://api.cloudflare.com/client/v4/accounts';
export const TYPESAFE_MODELS_URL = 'https://api.typesafe.ai/v1/models';
export const DEFAULT_MODELS_TIMEOUT_MS = 15_000;

/** Modelos Clef conocidos (sin prefijo). La allowlist la comparte `deriveClefModel`. */
export const CLEF_MODELS = ['clef', 'clef-flash', 'clef-omni'] as const;

const CLOUDFLARE_PREFIX = '@cf/cloudflare/';

/** Normaliza `@cf/cloudflare/<x>` → `<x>` (minúsculas, sin espacios). */
export function normalizeCloudflareModel(model: string): string {
  const trimmed = model.trim().toLowerCase();
  return trimmed.startsWith(CLOUDFLARE_PREFIX) ? trimmed.slice(CLOUDFLARE_PREFIX.length) : trimmed;
}

/**
 * Catálogo estático mínimo: lo que sabemos sin red. Los precios/contextos salen
 * del listado real de Workers AI y de TypeSafe (no inventar valores).
 */
const STATIC_CATALOG: readonly ModelInfo[] = [
  {
    id: '@cf/cloudflare/clef',
    name: 'Clef',
    provider: 'cloudflare',
    contextWindow: 65_536,
    inputPricePerMillion: 0.24,
    capabilities: { images: true },
    source: 'static',
    description: 'Clef (Workers AI), visión.',
  },
  {
    id: '@cf/cloudflare/clef-flash',
    name: 'Clef Flash',
    provider: 'cloudflare',
    contextWindow: 24_576,
    inputPricePerMillion: 0.038,
    capabilities: { images: true },
    source: 'static',
    description: 'Clef Flash (Workers AI), rápido y económico, visión.',
  },
  {
    id: '@cf/cloudflare/clef-omni',
    name: 'Clef Omni',
    provider: 'cloudflare',
    contextWindow: 65_536,
    inputPricePerMillion: 0.15,
    capabilities: { images: true, audio: true, video: true },
    source: 'static',
    description: 'Clef Omni (Workers AI), visión + audio/video.',
  },
  {
    id: 'jev-1.14.0',
    name: 'JEV 1.14.0',
    provider: 'typesafe',
    capabilities: { images: false },
    source: 'static',
    description: 'TypeSafe JEV (solo texto).',
  },
  {
    id: 'jev-1.13.0',
    name: 'JEV 1.13.0',
    provider: 'typesafe',
    capabilities: { images: false },
    source: 'static',
    description: 'TypeSafe JEV (solo texto).',
  },
  {
    id: 'jev-latest',
    name: 'JEV latest',
    provider: 'typesafe',
    capabilities: { images: false },
    source: 'static',
    description: 'Alias de la última versión de TypeSafe JEV (solo texto).',
  },
  {
    id: 'jev-preview',
    name: 'JEV preview',
    provider: 'typesafe',
    capabilities: { images: false },
    source: 'static',
    description: 'Alias preview de TypeSafe JEV (solo texto).',
  },
  {
    id: 'mock',
    name: 'Mock',
    provider: 'mock',
    capabilities: { images: true },
    source: 'static',
    description: 'Provider determinista para tests y desarrollo.',
  },
];

function cloneModel(model: ModelInfo): ModelInfo {
  return { ...model, capabilities: { ...model.capabilities } };
}

/** Modelos estáticos conocidos de un kind (copia defensiva). */
export function staticModelsFor(kind: ProviderKind): ModelInfo[] {
  return STATIC_CATALOG.filter((model) => model.provider === kind).map(cloneModel);
}

export function findStaticModel(kind: ProviderKind, id: string): ModelInfo | undefined {
  const normalized = kind === 'cloudflare' ? normalizeCloudflareModel(id) : id.trim().toLowerCase();
  const found = STATIC_CATALOG.find((model) => {
    if (model.provider !== kind) return false;
    const candidate = kind === 'cloudflare' ? normalizeCloudflareModel(model.id) : model.id.toLowerCase();
    return candidate === normalized;
  });
  return found ? cloneModel(found) : undefined;
}

/**
 * Capacidades conocidas por kind/modelo.
 * `undefined` = desconocido (no se debe bloquear preventivamente).
 */
export function capabilitiesFor(kind: ProviderKind, model: string): ModelCapabilities | undefined {
  switch (kind) {
    case 'cloudflare':
      return normalizeCloudflareModel(model) === 'clef-omni'
        ? { images: true, audio: true, video: true }
        : { images: true };
    case 'typesafe':
      return { images: false };
    case 'mock':
      return { images: true };
    case 'systemone':
      return undefined;
  }
}

/**
 * Validación laxa para `m1 model use`: acepta ids del catálogo estático o ids
 * con forma válida para el provider (Clef/JEV/endpoint compatible).
 */
export function isValidModelId(kind: ProviderKind, id: string): boolean {
  const candidate = id.trim();
  if (candidate === '' || /\s/.test(candidate)) return false;
  if (findStaticModel(kind, candidate)) return true;
  switch (kind) {
    case 'cloudflare': {
      const normalized = normalizeCloudflareModel(candidate);
      return (CLEF_MODELS as readonly string[]).includes(normalized);
    }
    case 'typesafe':
      return /^jev-[a-z0-9][a-z0-9.-]*$/i.test(candidate);
    case 'systemone':
      // Endpoint compatible: el catálogo real lo define el servidor.
      return /^[a-z0-9][a-z0-9._:/-]*$/i.test(candidate);
    case 'mock':
      return candidate.toLowerCase() === 'mock';
  }
}

export interface ListModelsOptions {
  kind: ProviderKind;
  /** Modelo configurado (sólo informativo / para capacidades). */
  model?: string;
  baseUrl?: string;
  accountId?: string;
  apiKey?: string;
  search?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ListModelsResult {
  models: ModelInfo[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof M1Error) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * El catálogo de Workers AI usa `id` = UUID y `name` = id público del modelo
 * (`@cf/...`). Preferimos la forma que parezca un id de modelo, con fallback.
 */
function modelIdFrom(record: Record<string, unknown>, preferQualifiedName: boolean): string | undefined {
  const id = stringField(record, ['id', 'model']);
  const name = stringField(record, ['name']);
  if (preferQualifiedName && name && (name.startsWith('@') || name.includes('/'))) return name;
  if (id && !looksLikeUuid(id)) return id;
  if (name && !looksLikeUuid(name)) return name;
  return id ?? name;
}

function extractArray(payload: unknown, keys: string[]): unknown[] | undefined {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return undefined;
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return undefined;
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<unknown> {
  const init: RequestInit = { method: 'GET', headers };
  init.signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new M1Error('E_PROVIDER', 'error de red listando modelos', {
      details: errorMessage(error),
      cause: error,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new M1Error('E_PROVIDER', `HTTP ${response.status} listando modelos`, {
      details: text.slice(0, 300),
    });
  }
  if (text.trim() === '') {
    throw new M1Error('E_PROVIDER', 'respuesta vacía listando modelos');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new M1Error('E_PROVIDER', 'respuesta JSON inválida listando modelos', {
      details: text.slice(0, 300),
      cause: error,
    });
  }
}

function filterBySearch(models: ModelInfo[], search: string | undefined): ModelInfo[] {
  const query = search?.trim().toLowerCase();
  if (!query) return models;
  return models.filter((model) =>
    [model.id, model.name, model.description].some((value) => value?.toLowerCase().includes(query)),
  );
}

interface CloudflareProperties {
  contextWindow?: number;
  inputPricePerMillion?: number;
  vision?: boolean;
  audio?: boolean;
  video?: boolean;
}

/** Workers AI devuelve `properties` como `[{ property_id, value }]`. */
function readCloudflareProperties(raw: unknown): CloudflareProperties {
  const parsed: CloudflareProperties = {};
  if (!Array.isArray(raw)) return parsed;

  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const propertyId = typeof entry.property_id === 'string' ? entry.property_id : undefined;
    const value = entry.value;
    if (!propertyId) continue;

    if (propertyId === 'context_window') {
      const number = Number(value);
      if (Number.isFinite(number)) parsed.contextWindow = number;
      continue;
    }
    if (propertyId === 'price' && Array.isArray(value)) {
      for (const priceEntry of value) {
        if (!isRecord(priceEntry)) continue;
        const unit = typeof priceEntry.unit === 'string' ? priceEntry.unit.toLowerCase() : '';
        if (!unit.includes('input')) continue;
        if (typeof priceEntry.price === 'number' && Number.isFinite(priceEntry.price)) {
          parsed.inputPricePerMillion = priceEntry.price;
        }
      }
      continue;
    }
    if (propertyId === 'vision' || propertyId === 'audio' || propertyId === 'video') {
      if (value === true || value === 'true') parsed[propertyId] = true;
      else if (value === false || value === 'false') parsed[propertyId] = false;
    }
  }
  return parsed;
}

function mapCloudflareModel(raw: unknown): ModelInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const rawId = modelIdFrom(raw, true);
  if (!rawId) return undefined;

  const known = findStaticModel('cloudflare', rawId);
  const properties = readCloudflareProperties(raw.properties);
  const id = known?.id ?? rawId;
  const name = known?.name ?? stringField(raw, ['display_name', 'title']) ?? id;
  const description = stringField(raw, ['description']) ?? known?.description;
  const contextWindow = properties.contextWindow ?? known?.contextWindow;
  const inputPricePerMillion = properties.inputPricePerMillion ?? known?.inputPricePerMillion;

  const capabilities: ModelCapabilities =
    known?.capabilities ?? {
      images: properties.vision === true,
      ...(properties.audio === true ? { audio: true } : {}),
      ...(properties.video === true ? { video: true } : {}),
    };

  const model: ModelInfo = {
    id,
    name,
    provider: 'cloudflare',
    capabilities,
    source: 'api',
    ...(description !== undefined ? { description } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(inputPricePerMillion !== undefined ? { inputPricePerMillion } : {}),
  };
  return model;
}

function mapTypesafeModel(raw: unknown): ModelInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const rawId = modelIdFrom(raw, false);
  if (!rawId) return undefined;

  const known = findStaticModel('typesafe', rawId);
  const id = known?.id ?? rawId;
  const description = stringField(raw, ['description']) ?? known?.description;
  return {
    id,
    name: known?.name ?? stringField(raw, ['display_name', 'title']) ?? id,
    provider: 'typesafe',
    capabilities: { images: false },
    source: 'api',
    ...(description !== undefined ? { description } : {}),
    ...(known?.contextWindow !== undefined ? { contextWindow: known.contextWindow } : {}),
    ...(known?.inputPricePerMillion !== undefined
      ? { inputPricePerMillion: known.inputPricePerMillion }
      : {}),
  };
}

function mapSystemoneModel(raw: unknown): ModelInfo | undefined {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return {
      id: raw.trim(),
      provider: 'systemone',
      // Capacidades desconocidas: no bloqueamos vision (permitir es más seguro).
      capabilities: { images: true },
      source: 'api',
    };
  }
  if (!isRecord(raw)) return undefined;
  const id = stringField(raw, ['id', 'name', 'model']);
  if (!id) return undefined;
  const description = stringField(raw, ['description']);
  return {
    id,
    name: stringField(raw, ['name']) ?? id,
    provider: 'systemone',
    capabilities: { images: true },
    source: 'api',
    ...(description !== undefined ? { description } : {}),
  };
}

/** Deriva `.../v1/models` desde un baseUrl que apunta a `.../v1/systemone`. */
function typesafeModelsUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return TYPESAFE_MODELS_URL;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/models')) return trimmed;
  const v1 = trimmed.lastIndexOf('/v1/');
  if (v1 >= 0) return `${trimmed.slice(0, v1)}/v1/models`;
  return `${trimmed}/models`;
}

async function listCloudflare(options: ListModelsOptions, warnings: string[]): Promise<ModelInfo[]> {
  const staticModels = staticModelsFor('cloudflare');
  if (!options.accountId || !options.apiKey) {
    warnings.push('faltan credenciales de Cloudflare (accountId/API token): se usa el catálogo estático');
    return staticModels;
  }

  const query = options.search?.trim();
  // Sin búsqueda explícita listamos sólo Clef: es lo único que el provider puede
  // ejecutar (`deriveClefModel` rechaza el resto). El catálogo de Workers AI tiene
  // cientos de modelos y mostrarlos todos sería engañoso.
  const apiQuery = query ?? 'clef';
  const url = `${CLOUDFLARE_MODELS_BASE}/${encodeURIComponent(options.accountId)}/ai/models/search?search=${encodeURIComponent(apiQuery)}`;
  try {
    const payload = await getJson(
      url,
      { Authorization: `Bearer ${options.apiKey}` },
      { timeoutMs: options.timeoutMs, signal: options.signal },
    );
    const items = extractArray(payload, ['result', 'data', 'models']);
    if (!items) {
      throw new M1Error('E_PROVIDER', 'la respuesta no contiene un listado de modelos', {
        details: isRecord(payload) ? Object.keys(payload) : undefined,
      });
    }
    const models = items
      .map(mapCloudflareModel)
      .filter((model): model is ModelInfo => model !== undefined);
    // Defensa por si la API ignora `search`: sin búsqueda explícita, sólo Clef.
    return query
      ? models
      : models.filter((model) => {
          const normalized = normalizeCloudflareModel(model.id);
          return (CLEF_MODELS as readonly string[]).includes(normalized);
        });
  } catch (error) {
    warnings.push(
      `no se pudo listar modelos de Cloudflare (${errorMessage(error)}): se usa el catálogo estático`,
    );
    return staticModels;
  }
}

async function listTypesafe(options: ListModelsOptions, warnings: string[]): Promise<ModelInfo[]> {
  const staticModels = staticModelsFor('typesafe');
  if (!options.apiKey) {
    warnings.push('faltan credenciales de TypeSafe (API key): se usa el catálogo estático');
    return staticModels;
  }

  try {
    const payload = await getJson(
      typesafeModelsUrl(options.baseUrl),
      { Authorization: `Bearer ${options.apiKey}` },
      { timeoutMs: options.timeoutMs, signal: options.signal },
    );
    const items = extractArray(payload, ['data', 'result', 'models']);
    if (!items) {
      throw new M1Error('E_PROVIDER', 'la respuesta no contiene un listado de modelos', {
        details: isRecord(payload) ? Object.keys(payload) : undefined,
      });
    }
    return items
      .map(mapTypesafeModel)
      .filter((model): model is ModelInfo => model !== undefined);
  } catch (error) {
    warnings.push(
      `no se pudo listar modelos de TypeSafe (${errorMessage(error)}): se usa el catálogo estático`,
    );
    return staticModels;
  }
}

async function listSystemone(options: ListModelsOptions, warnings: string[]): Promise<ModelInfo[]> {
  if (!options.baseUrl) {
    warnings.push('provider systemone sin baseUrl: no se pudo consultar el catálogo');
    return [];
  }

  const url = `${options.baseUrl.trim().replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {};
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  try {
    const payload = await getJson(url, headers, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    const items = extractArray(payload, ['data', 'result', 'models']);
    if (!items) {
      throw new M1Error('E_PROVIDER', 'la respuesta no contiene un listado de modelos');
    }
    return items
      .map(mapSystemoneModel)
      .filter((model): model is ModelInfo => model !== undefined);
  } catch (error) {
    warnings.push(
      `no se pudo listar modelos del endpoint compatible (${errorMessage(error)}): catálogo vacío`,
    );
    return [];
  }
}

/**
 * Lista modelos del provider. Nunca lanza por fallas de red/HTTP: devuelve el
 * catálogo estático (o vacío) y acumula warnings.
 */
export async function listModels(options: ListModelsOptions): Promise<ListModelsResult> {
  const warnings: string[] = [];
  let models: ModelInfo[];

  switch (options.kind) {
    case 'cloudflare':
      models = await listCloudflare(options, warnings);
      break;
    case 'typesafe':
      models = await listTypesafe(options, warnings);
      break;
    case 'systemone':
      models = await listSystemone(options, warnings);
      break;
    case 'mock':
      models = staticModelsFor('mock');
      break;
    default:
      throw new M1Error('E_CONFIG', `kind de provider desconocido: ${String(options.kind)}`);
  }

  return { models: filterBySearch(models, options.search), warnings };
}
