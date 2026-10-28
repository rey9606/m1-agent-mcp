import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { M1Error } from '../src/core/errors.js';
import { createCloudflareProvider } from '../src/providers/cloudflare.js';
import { createMockProvider } from '../src/providers/mock.js';
import { createOpenRouterProvider } from '../src/providers/openrouter.js';
import { createProvider, defaultModelFor } from '../src/providers/registry.js';
import { createSystemOneProvider } from '../src/providers/systemone.js';
import { createTypesafeProvider } from '../src/providers/typesafe.js';
import type { DecisionRequest, ProviderConfig } from '../src/providers/types.js';

const ANSWERS = { q1: { type: 'noul', noul: 0.9 } } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: () => Response) {
  const fn = vi.fn(async () => handler());
  vi.stubGlobal('fetch', fn);
  return fn;
}

function callOf(fn: ReturnType<typeof stubFetch>, index = 0): { url: string; init: RequestInit } {
  const call = fn.mock.calls[index] as unknown as [string, RequestInit] | undefined;
  if (!call) throw new Error(`fetch no fue llamado (índice ${index})`);
  return { url: call[0], init: call[1] };
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

function baseRequest(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    model: 'ignorado',
    state: { user: 'ana' },
    questions: {
      q1: { type: 'noul', instructions: '¿seguir?' },
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('cloudflare (Clef)', () => {
  it('llama a la URL REST con headers y body.model derivado del model configurado', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ result: { model: 'clef', answers: ANSWERS, usage: {} }, success: true }),
    );
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      accountId: 'acc-123',
      apiKey: 'token-abc',
      model: '@cf/cloudflare/clef',
    });

    await provider.evaluate(baseRequest());

    const { url, init } = callOf(fetchMock);
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-123/ai/run/@cf/cloudflare/clef',
    );
    expect(init.method).toBe('POST');
    expect(headersOf(init)).toMatchObject({
      Authorization: 'Bearer token-abc',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('clef');
    expect(body.state).toEqual({ user: 'ana' });
    expect(body.questions).toEqual(baseRequest().questions);
  });

  it('usa el default clef-flash y deriva el body.model desde el nombre corto', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ result: { model: 'clef-flash', answers: ANSWERS } }),
    );
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      accountId: 'acc-123',
      apiKey: 'token-abc',
      model: 'clef-flash',
    });

    const res = await provider.evaluate(baseRequest());

    const { url, init } = callOf(fetchMock);
    expect(url).toContain('/@cf/cloudflare/clef-flash');
    expect((JSON.parse(String(init.body)) as Record<string, unknown>).model).toBe('clef-flash');
    expect(res.answers).toEqual(ANSWERS);
  });

  it('desenvuelve {result} en modo auto y adjunta raw', async () => {
    const rawBody = { result: { model: 'clef-flash', answers: ANSWERS }, success: true };
    stubFetch(() => jsonResponse(rawBody));
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      accountId: 'acc-123',
      apiKey: 'token-abc',
    });

    const res = await provider.evaluate(baseRequest());

    expect(res.model).toBe('clef-flash');
    expect(res.answers).toEqual(ANSWERS);
    expect(res.raw).toEqual(rawBody);
  });

  it('acepta una respuesta directa sin envoltorio', async () => {
    stubFetch(() => jsonResponse({ model: 'clef-flash', answers: ANSWERS, usage: { input_tokens: 3 } }));
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      accountId: 'acc-123',
      apiKey: 'token-abc',
    });

    const res = await provider.evaluate(baseRequest());

    expect(res.answers).toEqual(ANSWERS);
    expect(res.usage).toEqual({ input_tokens: 3 });
  });

  it('respeta unwrap: none', async () => {
    stubFetch(() => jsonResponse({ result: { answers: ANSWERS } }));
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      accountId: 'acc-123',
      apiKey: 'token-abc',
      unwrap: 'none',
    });

    await expect(provider.evaluate(baseRequest())).rejects.toMatchObject({ code: 'E_PROVIDER' });
  });

  it('mapea 401 a E_PROVIDER con hint de token/permisos', async () => {
    stubFetch(() => jsonResponse({ errors: [{ code: 10000 }] }, 401));
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      accountId: 'acc-123',
      apiKey: 'token-malo',
    });

    const error = await provider.evaluate(baseRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).code).toBe('E_PROVIDER');
    expect((error as M1Error).message).toBe('Cloudflare 401');
    expect((error as M1Error).hint).toContain('token');
    expect((error as M1Error).details).toContain('10000');
  });

  it('pasa las imágenes tal cual', async () => {
    const images = [{ content_type: 'image/png', base64: 'aGVsbG8=' }];
    const fetchMock = stubFetch(() => jsonResponse({ result: { answers: ANSWERS } }));
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      accountId: 'acc-123',
      apiKey: 'token-abc',
    });

    await provider.evaluate(baseRequest({ images }));

    const body = JSON.parse(String(callOf(fetchMock).init.body)) as Record<string, unknown>;
    expect(body.images).toEqual(images);
  });

  it('falla con E_CONFIG si falta accountId', async () => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
    const provider = createCloudflareProvider('clef', {
      kind: 'cloudflare',
      apiKey: 'token-abc',
    });

    const error = await provider.evaluate(baseRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).code).toBe('E_CONFIG');
    expect((error as M1Error).message).toContain('accountId');
  });
});

describe('typesafe (JEV)', () => {
  it('llama al endpoint con model jev-latest y Authorization Bearer', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ model: 'jev-latest', answers: ANSWERS }));
    const provider = createTypesafeProvider('jev', {
      kind: 'typesafe',
      apiKey: 'ts-key',
    });

    const res = await provider.evaluate(baseRequest());

    const { url, init } = callOf(fetchMock);
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(headersOf(init).Authorization).toBe('Bearer ts-key');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('jev-latest');
    expect(body.images).toBeUndefined();
    expect(res.answers).toEqual(ANSWERS);
  });

  it('rechaza imágenes con E_PROVIDER y hint de Clef', async () => {
    const provider = createTypesafeProvider('jev', {
      kind: 'typesafe',
      apiKey: 'ts-key',
    });

    const error = await provider
      .evaluate(baseRequest({ images: [{ content_type: 'image/png', base64: 'x' }] }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).code).toBe('E_PROVIDER');
    expect((error as M1Error).hint).toBe('JEV no soporta imágenes; usá Clef');
  });
});

describe('openrouter (System One)', () => {
  it('llama al endpoint systemone con el modelo configurado y Bearer', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ model: 'typesafe/jev-1.14', answers: ANSWERS }),
    );
    const provider = createOpenRouterProvider('or', {
      kind: 'openrouter',
      apiKey: 'or-key',
      model: 'typesafe/jev-1.14',
    });

    const res = await provider.evaluate(baseRequest());

    const { url, init } = callOf(fetchMock);
    expect(url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(headersOf(init).Authorization).toBe('Bearer or-key');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('typesafe/jev-1.14');
    expect(body.images).toBeUndefined();
    expect(res.answers).toEqual(ANSWERS);
  });

  it('usa OPENROUTER_KEY y el modelo default typesafe/jev-1.14', async () => {
    vi.stubEnv('OPENROUTER_KEY', 'env-key');
    const fetchMock = stubFetch(() => jsonResponse({ answers: ANSWERS }));
    const provider = createOpenRouterProvider('or', { kind: 'openrouter' });

    await provider.evaluate(baseRequest());

    expect(headersOf(callOf(fetchMock).init).Authorization).toBe('Bearer env-key');
    const body = JSON.parse(String(callOf(fetchMock).init.body)) as Record<string, unknown>;
    expect(body.model).toBe('typesafe/jev-1.14');
  });

  it('falla con E_CONFIG si no hay API key', async () => {
    vi.stubEnv('OPENROUTER_KEY', '');
    const provider = createOpenRouterProvider('or', { kind: 'openrouter' });

    const error = await provider.evaluate(baseRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).code).toBe('E_CONFIG');
    expect((error as M1Error).hint).toContain('OPENROUTER_KEY');
  });

  it('mueve las imágenes dentro de state como partes image_url', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ answers: ANSWERS }));
    const provider = createOpenRouterProvider('or', {
      kind: 'openrouter',
      apiKey: 'or-key',
    });

    await provider.evaluate(
      baseRequest({
        state: 'estado textual',
        images: [{ content_type: 'image/png', base64: 'aGVsbG8=' }],
      }),
    );

    const body = JSON.parse(String(callOf(fetchMock).init.body)) as Record<string, unknown>;
    expect(body.images).toBeUndefined();
    expect(body.state).toEqual([
      'estado textual',
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aGVsbG8=' },
      },
    ]);
  });

  it('hace append de imágenes a un state array', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ answers: ANSWERS }));
    const provider = createOpenRouterProvider('or', {
      kind: 'openrouter',
      apiKey: 'or-key',
    });

    await provider.evaluate(
      baseRequest({
        state: [{ type: 'text', text: 'hola' }],
        images: [{ content_type: 'image/jpeg', base64: 'eA==' }],
      }),
    );

    const body = JSON.parse(String(callOf(fetchMock).init.body)) as Record<string, unknown>;
    expect(body.state).toEqual([
      { type: 'text', text: 'hola' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,eA==' } },
    ]);
  });

  it('rechaza state objeto con imágenes antes de llamar a la API', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ answers: ANSWERS }));
    const provider = createOpenRouterProvider('or', {
      kind: 'openrouter',
      apiKey: 'or-key',
    });

    const error = await provider
      .evaluate(
        baseRequest({
          state: { user: 'ana' },
          images: [{ content_type: 'image/png', base64: 'eA==' }],
        }),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).code).toBe('E_CONFIG');
    expect((error as M1Error).details).toMatchObject({ stateType: 'object', images: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('mapea 401 y 402 a E_PROVIDER con hints propios', async () => {
    for (const [status, hint] of [
      [401, 'OPENROUTER_KEY'],
      [402, 'créditos'],
    ] as const) {
      stubFetch(() => jsonResponse({ error: 'nope' }, status));
      const provider = createOpenRouterProvider('or', {
        kind: 'openrouter',
        apiKey: 'or-key',
      });

      const error = await provider.evaluate(baseRequest()).catch((e: unknown) => e);
      expect((error as M1Error).code).toBe('E_PROVIDER');
      expect((error as M1Error).message).toBe(`OpenRouter ${status}`);
      expect((error as M1Error).hint).toContain(hint);
      vi.unstubAllGlobals();
    }
  });

  it('marca imágenes como no soportadas en modelos free sólo texto', () => {
    const free = createOpenRouterProvider('or', {
      kind: 'openrouter',
      model: 'baseten/mammoth-1:free',
    });
    const vision = createOpenRouterProvider('or', {
      kind: 'openrouter',
      model: 'typesafe/jev-1.14',
    });

    expect(free.capabilities?.images).toBe(false);
    expect(vision.capabilities?.images).toBe(true);
  });
});

describe('systemone (endpoint compatible)', () => {
  it('usa baseUrl y headers custom, con auth cuando hay key', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ model: 'local-decision', answers: ANSWERS }));
    const provider = createSystemOneProvider('local', {
      kind: 'systemone',
      baseUrl: 'https://example.test/decide',
      apiKey: 'local-key',
      headers: { 'x-team': 'core' },
    });

    await provider.evaluate(baseRequest());

    const { url, init } = callOf(fetchMock);
    expect(url).toBe('https://example.test/decide');
    expect(headersOf(init)).toMatchObject({
      'x-team': 'core',
      Authorization: 'Bearer local-key',
      'Content-Type': 'application/json',
    });
    expect((JSON.parse(String(init.body)) as Record<string, unknown>).model).toBe('local-decision');
  });

  it('omite Authorization si no hay key', async () => {
    vi.stubEnv('SYSTEMONE_API_KEY', '');
    const fetchMock = stubFetch(() => jsonResponse({ answers: ANSWERS }));
    const provider = createSystemOneProvider('local', {
      kind: 'systemone',
      baseUrl: 'https://example.test/decide',
    });

    await provider.evaluate(baseRequest());

    expect(headersOf(callOf(fetchMock).init).Authorization).toBeUndefined();
  });

  it('convierte imágenes a data URLs con imageFormat=dataUrl', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ answers: ANSWERS }));
    const provider = createSystemOneProvider('liquid', {
      kind: 'systemone',
      baseUrl: 'http://127.0.0.1:9931/v1/systemone',
      imageFormat: 'dataUrl',
    });

    await provider.evaluate(
      baseRequest({ images: [{ content_type: 'image/png', base64: 'aGVsbG8=' }] }),
    );

    const body = JSON.parse(String(callOf(fetchMock).init.body)) as { images: string[] };
    expect(body.images).toEqual(['data:image/png;base64,aGVsbG8=']);
  });

  it('mantiene el formato objeto por defecto', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ answers: ANSWERS }));
    const provider = createSystemOneProvider('local', {
      kind: 'systemone',
      baseUrl: 'https://example.test/decide',
    });
    const images = [{ content_type: 'image/png', base64: 'aGVsbG8=' }];

    await provider.evaluate(baseRequest({ images }));

    const body = JSON.parse(String(callOf(fetchMock).init.body)) as { images: unknown };
    expect(body.images).toEqual(images);
  });
});

describe('mock', () => {
  it('sintetiza los tres tipos reflejando exactamente las preguntas', async () => {
    const provider = createMockProvider('fake', { kind: 'mock' });

    const res = await provider.evaluate(
      baseRequest({
        questions: {
          n: { type: 'noul', instructions: '¿seguir?' },
          c: { type: 'choice', instructions: 'elegí', criteria: { a: 1, b: 2, c: 3 } },
          s: { type: 'score', instructions: 'puntuá', criteria: [1, 2, 3] },
        },
      }),
    );

    expect(Object.keys(res.answers).sort()).toEqual(['c', 'n', 's']);
    expect(res.answers.n).toEqual({ type: 'noul', noul: 0.82 });

    const choice = res.answers.c;
    expect(choice).toMatchObject({ type: 'choice', choice: 'a', confidence: 0.72 });
    if (choice?.type !== 'choice') throw new Error('se esperaba choice');
    expect(choice.probabilities).toEqual({ a: 0.72, b: 0.14, c: 0.14 });

    const score = res.answers.s;
    expect(score).toMatchObject({ type: 'score', score: 1, confidence: 0.66 });
    if (score?.type !== 'score') throw new Error('se esperaba score');
    expect(score.probabilities).toEqual({ '0': 1 / 3, '1': 1 / 3, '2': 1 / 3 });

    expect(res.usage).toEqual({ input_tokens: 100, output_tokens: 0 });
  });

  it('usa fixtures parciales y sintetiza lo que falta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-mock-'));
    try {
      writeFileSync(
        join(dir, 'answers.json'),
        JSON.stringify({
          fija: { type: 'noul', noul: 0.1 },
          sobrante: { type: 'noul', noul: 0.5 },
        }),
      );
      const provider = createMockProvider('fake', { kind: 'mock', fixturesDir: dir });

      const res = await provider.evaluate(
        baseRequest({
          questions: {
            fija: { type: 'noul', instructions: 'viene del fixture' },
            nueva: { type: 'choice', instructions: 'elegí', criteria: { x: 1, y: 2 } },
          },
        }),
      );

      expect(Object.keys(res.answers).sort()).toEqual(['fija', 'nueva']);
      expect(res.answers.fija).toEqual({ type: 'noul', noul: 0.1 });
      expect(res.answers.nueva).toMatchObject({ type: 'choice', choice: 'x' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('registry', () => {
  it('expone el modelo default por kind', () => {
    expect(defaultModelFor('cloudflare')).toBe('@cf/cloudflare/clef-flash');
    expect(defaultModelFor('typesafe')).toBe('jev-latest');
    expect(defaultModelFor('openrouter')).toBe('typesafe/jev-1.14');
    expect(defaultModelFor('systemone')).toBe('local-decision');
    expect(defaultModelFor('mock')).toBe('mock');
  });

  it('crea los cinco kinds', () => {
    const cases: ProviderConfig[] = [
      { kind: 'cloudflare', accountId: 'a', apiKey: 't' },
      { kind: 'typesafe', apiKey: 'k' },
      { kind: 'openrouter', apiKey: 'k' },
      { kind: 'systemone', baseUrl: 'https://example.test' },
      { kind: 'mock' },
    ];

    for (const cfg of cases) {
      const provider = createProvider(`p-${cfg.kind}`, cfg);
      expect(provider.name).toBe(`p-${cfg.kind}`);
      expect(provider.kind).toBe(cfg.kind);
    }
  });

  it('rechaza un kind inválido con E_CONFIG y lista de válidos', () => {
    const cfg = { kind: 'inexistente' } as unknown as ProviderConfig;
    const error = (() => {
      try {
        createProvider('x', cfg);
      } catch (e) {
        return e;
      }
    })();

    expect(error).toBeInstanceOf(M1Error);
    expect((error as M1Error).code).toBe('E_CONFIG');
    expect((error as M1Error).hint).toContain('openrouter');
  });
});
