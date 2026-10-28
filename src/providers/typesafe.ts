import { M1Error } from '../core/errors.js';
import {
  CLOUDFLARE_DEFAULT_TIMEOUT_MS,
  postDecisionJson,
  resolveSecret,
  toDecisionResponse,
  unwrapDecision,
} from './cloudflare.js';
import type {
  DecideOptions,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  ProviderConfig,
} from './types.js';

export const TYPESAFE_DEFAULT_URL = 'https://api.typesafe.ai/v1/systemone';
export const TYPESAFE_DEFAULT_MODEL = 'jev-latest';

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'API key de TypeSafe inválida o sin permisos';
  }
  if (status === 429) {
    return 'rate limit de TypeSafe: esperá y reintentá o bajá la concurrencia';
  }
  return undefined;
}

export function createTypesafeProvider(name: string, cfg: ProviderConfig): DecisionProvider {
  return {
    name,
    kind: 'typesafe',
    capabilities: { images: false },
    async evaluate(request: DecisionRequest, options?: DecideOptions): Promise<DecisionResponse> {
      if (request.images && request.images.length > 0) {
        throw new M1Error('E_PROVIDER', 'JEV no soporta imágenes', {
          hint: 'JEV no soporta imágenes; usá Clef',
          details: { images: request.images.length },
        });
      }

      const key = resolveSecret(cfg, 'TYPESAFE_API_KEY');
      if (!key) {
        throw new M1Error('E_CONFIG', 'falta API key de TypeSafe', {
          hint: 'definí TYPESAFE_API_KEY o provider.apiKeyEnv/provider.apiKey',
        });
      }

      const model = cfg.model ?? TYPESAFE_DEFAULT_MODEL;
      const url = cfg.baseUrl ?? TYPESAFE_DEFAULT_URL;

      const raw = await postDecisionJson({
        provider: 'TypeSafe',
        url,
        headers: {
          ...(cfg.headers ?? {}),
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: { model, state: request.state, questions: request.questions },
        timeoutMs: cfg.timeoutMs ?? CLOUDFLARE_DEFAULT_TIMEOUT_MS,
        signal: options?.signal,
        hintForStatus,
      });

      const payload = unwrapDecision(raw, cfg.unwrap ?? 'auto');
      return toDecisionResponse(payload, { provider: 'TypeSafe', model, raw });
    },
  };
}
