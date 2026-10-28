import { M1Error } from '../core/errors.js';
import type {
  DecideOptions,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  ProviderConfig,
} from './types.js';

export const CLOUDFLARE_DEFAULT_MODEL = '@cf/cloudflare/clef-flash';
export const CLEF_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';
export const CLOUDFLARE_DEFAULT_TIMEOUT_MS = 60_000;

export type ClefModel = 'clef' | 'clef-flash';

/** Deriva el `model` del body desde el nombre público del modelo (con o sin prefijo `@cf/...`). */
export function deriveClefModel(model: string): ClefModel {
  const normalized = model.trim().toLowerCase();
  if (normalized === 'clef' || normalized === '@cf/cloudflare/clef') return 'clef';
  if (normalized === 'clef-flash' || normalized === '@cf/cloudflare/clef-flash') return 'clef-flash';
  throw new M1Error('E_CONFIG', `modelo de Clef inválido: ${model}`, {
    hint: "usá '@cf/cloudflare/clef-flash' o '@cf/cloudflare/clef'",
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `cfg.apiKey` gana; si no, se lee la env var indicada (o la default del provider). */
export function resolveSecret(cfg: ProviderConfig, defaultEnv: string): string | undefined {
  const fromEnv = process.env[cfg.apiKeyEnv ?? defaultEnv];
  return cfg.apiKey ?? (fromEnv ? fromEnv : undefined);
}

/** Compone el timeout propio con la señal externa (AbortSignal.any cuando está disponible). */
export function composeSignal(timeoutMs: number, outer?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!outer) return timeoutSignal;

  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') return anyFn.call(AbortSignal, [timeoutSignal, outer]);

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (outer.aborted) controller.abort(outer.reason);
  else outer.addEventListener('abort', abortFrom(outer), { once: true });
  timeoutSignal.addEventListener('abort', abortFrom(timeoutSignal), { once: true });
  return controller.signal;
}

/** Desenvuelve `{result: {...}}` según el modo configurado. */
export function unwrapDecision(payload: unknown, mode: ProviderConfig['unwrap'] = 'auto'): unknown {
  if (mode === 'none') return payload;
  if (mode === 'result') {
    if (!isRecord(payload) || !('result' in payload)) {
      throw new M1Error('E_PROVIDER', 'la respuesta no contiene `result`', { details: payload });
    }
    return payload.result;
  }
  // auto: sólo desenvolver si envuelve y la raíz no trae ya las respuestas.
  if (isRecord(payload) && 'answers' in payload) return payload;
  if (isRecord(payload) && isRecord(payload.result)) return payload.result;
  return payload;
}

export interface PostDecisionOptions {
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  hintForStatus?: (status: number) => string | undefined;
}

/** POST JSON con timeout, manejo de non-2xx y parseo estricto. Devuelve el JSON original. */
export async function postDecisionJson(opts: PostDecisionOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: 'POST',
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: composeSignal(opts.timeoutMs, opts.signal),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new M1Error('E_TIMEOUT', `${opts.provider}: timeout tras ${opts.timeoutMs}ms`, {
        hint: 'aumentá provider.timeoutMs o revisá la conectividad',
        cause: error,
      });
    }
    throw new M1Error('E_PROVIDER', `${opts.provider}: error de red`, {
      details: (error as Error | undefined)?.message,
      hint: 'revisá la URL/baseUrl y la conectividad',
      cause: error,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new M1Error('E_PROVIDER', `${opts.provider} ${response.status}`, {
      details: text.slice(0, 500),
      hint: opts.hintForStatus?.(response.status),
    });
  }

  if (text.trim() === '') {
    throw new M1Error('E_PROVIDER', `${opts.provider}: respuesta vacía`, { details: text });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new M1Error('E_PROVIDER', `${opts.provider}: respuesta JSON inválida`, {
      details: text.slice(0, 500),
      cause: error,
    });
  }
}

/** Valida mínimamente `{answers}` y normaliza la respuesta del contrato. */
export function toDecisionResponse(
  payload: unknown,
  opts: { provider: string; model: string; raw: unknown },
): DecisionResponse {
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    throw new M1Error('E_PROVIDER', `${opts.provider}: la respuesta no contiene \`answers\``, {
      details: opts.raw,
      hint: 'verificá el modelo/endpoint o el modo `unwrap` del provider',
    });
  }

  const response: DecisionResponse = {
    model: typeof payload.model === 'string' ? payload.model : opts.model,
    answers: payload.answers as DecisionResponse['answers'],
    raw: opts.raw,
  };
  if (isRecord(payload.usage)) {
    response.usage = payload.usage as DecisionResponse['usage'];
  }
  return response;
}

function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'token de Cloudflare inválido o sin permisos sobre Workers AI';
  }
  if (status === 429) {
    return 'rate limit de Cloudflare: esperá y reintentá o bajá la concurrencia';
  }
  if (status === 404) {
    return 'verificá accountId y que el modelo Clef esté habilitado en la cuenta';
  }
  return undefined;
}

export function createCloudflareProvider(name: string, cfg: ProviderConfig): DecisionProvider {
  return {
    name,
    kind: 'cloudflare',
    async evaluate(request: DecisionRequest, options?: DecideOptions): Promise<DecisionResponse> {
      const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) {
        throw new M1Error('E_CONFIG', 'falta accountId de Cloudflare', {
          hint: 'definí CLOUDFLARE_ACCOUNT_ID o provider.accountId en la config',
        });
      }

      const token = resolveSecret(cfg, 'CLOUDFLARE_API_TOKEN');
      if (!token) {
        throw new M1Error('E_CONFIG', 'falta API token de Cloudflare', {
          hint: 'definí CLOUDFLARE_API_TOKEN o provider.apiKeyEnv/provider.apiKey',
        });
      }

      const model = deriveClefModel(cfg.model ?? CLOUDFLARE_DEFAULT_MODEL);
      const url = `${CLEF_API_BASE}/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`;

      const body: Record<string, unknown> = {
        model,
        state: request.state,
        questions: request.questions,
      };
      if (request.images && request.images.length > 0) body.images = request.images;

      const raw = await postDecisionJson({
        provider: 'Cloudflare',
        url,
        headers: {
          ...(cfg.headers ?? {}),
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body,
        timeoutMs: cfg.timeoutMs ?? CLOUDFLARE_DEFAULT_TIMEOUT_MS,
        signal: options?.signal,
        hintForStatus,
      });

      const payload = unwrapDecision(raw, cfg.unwrap ?? 'auto');
      return toDecisionResponse(payload, { provider: 'Cloudflare', model, raw });
    },
  };
}
