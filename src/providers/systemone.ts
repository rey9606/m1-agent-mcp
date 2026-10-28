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

export const SYSTEMONE_DEFAULT_MODEL = 'local-decision';

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'el endpoint rechazó las credenciales: revisá provider.apiKey/apiKeyEnv';
  }
  if (status === 404) {
    return 'verificá provider.baseUrl del endpoint compatible';
  }
  if (status === 429) {
    return 'rate limit del endpoint: esperá y reintentá o bajá la concurrencia';
  }
  return undefined;
}

export function createSystemOneProvider(name: string, cfg: ProviderConfig): DecisionProvider {
  return {
    name,
    kind: 'systemone',
    capabilities: { images: true },
    async evaluate(request: DecisionRequest, options?: DecideOptions): Promise<DecisionResponse> {
      if (!cfg.baseUrl) {
        throw new M1Error('E_CONFIG', 'falta baseUrl del endpoint compatible', {
          hint: 'definí provider.baseUrl con la URL completa del endpoint SystemOne',
        });
      }

      const model = cfg.model ?? SYSTEMONE_DEFAULT_MODEL;
      const key = resolveSecret(cfg, 'SYSTEMONE_API_KEY');

      const headers: Record<string, string> = {
        ...(cfg.headers ?? {}),
        'Content-Type': 'application/json',
      };
      if (key) headers.Authorization = `Bearer ${key}`;

      const body: Record<string, unknown> = {
        model,
        state: request.state,
        questions: request.questions,
      };
      if (request.images && request.images.length > 0) {
        body.images =
          cfg.imageFormat === 'dataUrl'
            ? request.images.map((image) => `data:${image.content_type};base64,${image.base64}`)
            : request.images;
      }

      const raw = await postDecisionJson({
        provider: 'SystemOne',
        url: cfg.baseUrl,
        headers,
        body,
        timeoutMs: cfg.timeoutMs ?? CLOUDFLARE_DEFAULT_TIMEOUT_MS,
        signal: options?.signal,
        hintForStatus,
      });

      const payload = unwrapDecision(raw, cfg.unwrap ?? 'auto');
      return toDecisionResponse(payload, { provider: 'SystemOne', model, raw });
    },
  };
}
