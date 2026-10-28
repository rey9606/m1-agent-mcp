import { M1Error } from '../core/errors.js';
import {
  CLOUDFLARE_DEFAULT_TIMEOUT_MS,
  postDecisionJson,
  resolveSecret,
  toDecisionResponse,
  unwrapDecision,
} from './cloudflare.js';
import { capabilitiesFor } from './models.js';
import type {
  DecideOptions,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  ImageInput,
  ProviderConfig,
} from './types.js';

/** Superficie System One de OpenRouter: mismo contrato que TypeSafe. */
export const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1/systemone';
export const OPENROUTER_DEFAULT_MODEL = 'typesafe/jev-1.14';
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
export const OPENROUTER_KEY_ENV = 'OPENROUTER_KEY';

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'API key de OpenRouter inválida o sin permisos (OPENROUTER_KEY)';
  }
  if (status === 402) {
    return 'la cuenta de OpenRouter no tiene créditos para ese modelo';
  }
  if (status === 429) {
    return 'rate limit de OpenRouter: esperá y reintentá (los modelos :free son más limitados)';
  }
  if (status === 400) {
    return 'revisá el modelo y el formato de state/images para ese modelo';
  }
  return undefined;
}

function imagePart(image: ImageInput): { type: 'image_url'; image_url: { url: string } } {
  return {
    type: 'image_url',
    image_url: { url: `data:${image.content_type};base64,${image.base64}` },
  };
}

/**
 * OpenRouter no acepta un campo `images` de nivel superior (responde 400): las
 * imágenes van dentro de `state` como partes `image_url`.
 *
 * - `state` string → `[texto, ...imágenes]`
 * - `state` array  → `[...state, ...imágenes]`
 * - `state` objeto → no se puede representar sin cambiar la semántica del state.
 */
export function stateWithImages(state: unknown, images: ImageInput[]): unknown {
  const parts = images.map(imagePart);
  if (Array.isArray(state)) return [...state, ...parts];
  if (typeof state === 'string') return [state, ...parts];
  throw new M1Error('E_CONFIG', 'OpenRouter requiere `state` como string o array para adjuntar imágenes', {
    hint: 'usá un state string/array, o quitá --image; OpenRouter no acepta `images` de nivel superior',
    details: { stateType: state === null ? 'null' : typeof state, images: images.length },
  });
}

export function createOpenRouterProvider(name: string, cfg: ProviderConfig): DecisionProvider {
  const model = cfg.model ?? OPENROUTER_DEFAULT_MODEL;
  const capabilities = capabilitiesFor('openrouter', model);

  return {
    name,
    kind: 'openrouter',
    // Desconocido = permitir: sólo se bloquea cuando sabemos que el modelo es texto puro.
    capabilities: { images: capabilities?.images ?? true },
    async evaluate(request: DecisionRequest, options?: DecideOptions): Promise<DecisionResponse> {
      const key = resolveSecret(cfg, OPENROUTER_KEY_ENV);
      if (!key) {
        throw new M1Error('E_CONFIG', 'falta API key de OpenRouter', {
          hint: 'definí OPENROUTER_KEY en .env o provider.apiKeyEnv/provider.apiKey',
        });
      }

      const hasImages = Boolean(request.images && request.images.length > 0);
      const body = {
        model,
        state: hasImages ? stateWithImages(request.state, request.images ?? []) : request.state,
        questions: request.questions,
      };

      const raw = await postDecisionJson({
        provider: 'OpenRouter',
        url: cfg.baseUrl ?? OPENROUTER_DEFAULT_URL,
        headers: {
          ...(cfg.headers ?? {}),
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body,
        timeoutMs: cfg.timeoutMs ?? CLOUDFLARE_DEFAULT_TIMEOUT_MS,
        signal: options?.signal,
        hintForStatus,
      });

      const payload = unwrapDecision(raw, cfg.unwrap ?? 'auto');
      return toDecisionResponse(payload, { provider: 'OpenRouter', model, raw });
    },
  };
}
