import { afterEach, describe, expect, it, vi } from 'vitest';

import { M1Error } from '../src/core/errors.js';
import { deriveClefModel } from '../src/providers/cloudflare.js';
import {
  capabilitiesFor,
  isValidModelId,
  listModels,
  staticModelsFor,
} from '../src/providers/models.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: () => Response | Promise<Response>) {
  const fn = vi.fn(async () => handler());
  vi.stubGlobal('fetch', fn);
  return fn;
}

function callOf(fn: ReturnType<typeof stubFetch>, index = 0): { url: string; init: RequestInit } {
  const call = fn.mock.calls[index] as unknown as [string, RequestInit] | undefined;
  if (!call) throw new Error(`fetch no fue llamado (índice ${index})`);
  return { url: call[0], init: call[1] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('catálogo estático', () => {
  it('incluye los 3 Clef con vision y sus contextos/precios', () => {
    const models = staticModelsFor('cloudflare');

    expect(models.map((model) => model.id)).toEqual([
      '@cf/cloudflare/clef',
      '@cf/cloudflare/clef-flash',
      '@cf/cloudflare/clef-omni',
    ]);
    expect(models.every((model) => model.capabilities.images)).toBe(true);
    expect(models.find((model) => model.id.endsWith('clef-flash'))?.contextWindow).toBe(24_576);
    expect(models.find((model) => model.id.endsWith('clef-omni'))?.contextWindow).toBe(65_536);
    expect(models.find((model) => model.id.endsWith('clef-omni'))?.capabilities.audio).toBe(true);
  });

  it('incluye las versiones/alias de JEV sin vision', () => {
    const models = staticModelsFor('typesafe');
    const ids = models.map((model) => model.id);

    expect(ids).toContain('jev-1.14.0');
    expect(ids).toContain('jev-1.13.0');
    expect(ids).toContain('jev-latest');
    expect(ids).toContain('jev-preview');
    expect(models.every((model) => model.capabilities.images === false)).toBe(true);
  });

  it('mock tiene su catálogo mínimo', () => {
    expect(staticModelsFor('mock').map((model) => model.id)).toEqual(['mock']);
  });

  it('openrouter incluye los free y los modelos con visión', () => {
    const models = staticModelsFor('openrouter');
    const free = models.filter((model) => model.free);

    expect(free.map((model) => model.id).sort()).toEqual([
      'baseten/elephant-1:free',
      'baseten/mammoth-1:free',
      'respan/span-01-lite:free',
    ]);
    expect(free.every((model) => model.inputPricePerMillion === 0)).toBe(true);
    expect(free.every((model) => model.capabilities.images === false)).toBe(true);
    expect(models.find((model) => model.id === 'typesafe/jev-1.14')?.capabilities.images).toBe(true);
  });
});

describe('capabilitiesFor', () => {
  it('Cloudflare soporta imágenes con o sin prefijo', () => {
    expect(capabilitiesFor('cloudflare', 'clef-flash')).toEqual({ images: true });
    expect(capabilitiesFor('cloudflare', '@cf/cloudflare/clef')).toEqual({ images: true });
    expect(capabilitiesFor('cloudflare', '@cf/cloudflare/clef-omni')).toMatchObject({
      images: true,
      audio: true,
      video: true,
    });
  });

  it('TypeSafe no soporta imágenes', () => {
    expect(capabilitiesFor('typesafe', 'jev-1.14.0')).toEqual({ images: false });
  });

  it('mock soporta imágenes y systemone es desconocido', () => {
    expect(capabilitiesFor('mock', 'mock')).toEqual({ images: true });
    expect(capabilitiesFor('systemone', 'local-decision')).toBeUndefined();
  });

  it('openrouter distingue texto puro, visión y omni', () => {
    expect(capabilitiesFor('openrouter', 'baseten/mammoth-1:free')).toEqual({ images: false });
    expect(capabilitiesFor('openrouter', 'respan/span-01-lite:free')).toEqual({ images: false });
    expect(capabilitiesFor('openrouter', 'typesafe/jev-1.14')).toEqual({ images: true });
    expect(capabilitiesFor('openrouter', 'desconocido/modelo')).toEqual({ images: true });
    expect(capabilitiesFor('openrouter', 'cloudflare/clef-omni')).toEqual({
      images: true,
      audio: true,
      video: true,
    });
  });
});

describe('isValidModelId', () => {
  it('acepta ids conocidos y variantes válidas por provider', () => {
    expect(isValidModelId('cloudflare', 'clef-omni')).toBe(true);
    expect(isValidModelId('cloudflare', '@cf/cloudflare/clef-flash')).toBe(true);
    expect(isValidModelId('typesafe', 'jev-1.14.0')).toBe(true);
    expect(isValidModelId('typesafe', 'jev-2.0.0')).toBe(true);
    expect(isValidModelId('systemone', 'cualquier-modelo')).toBe(true);
    expect(isValidModelId('mock', 'mock')).toBe(true);
    expect(isValidModelId('openrouter', 'typesafe/jev-1.14')).toBe(true);
    expect(isValidModelId('openrouter', 'baseten/mammoth-1:free')).toBe(true);
    expect(isValidModelId('openrouter', '~typesafe/jev-latest')).toBe(true);
  });

  it('rechaza ids con forma inválida', () => {
    expect(isValidModelId('cloudflare', 'gpt-4o')).toBe(false);
    expect(isValidModelId('typesafe', 'clef-flash')).toBe(false);
    expect(isValidModelId('mock', 'otro')).toBe(false);
    expect(isValidModelId('systemone', 'con espacios')).toBe(false);
    expect(isValidModelId('openrouter', 'sin-slash')).toBe(false);
    expect(isValidModelId('openrouter', 'con espacios/modelo')).toBe(false);
  });
});

describe('deriveClefModel', () => {
  it('acepta clef-omni y el prefijo @cf/cloudflare/', () => {
    expect(deriveClefModel('clef-omni')).toBe('clef-omni');
    expect(deriveClefModel('@cf/cloudflare/clef-omni')).toBe('clef-omni');
    expect(deriveClefModel('@cf/cloudflare/CLEF-FLASH')).toBe('clef-flash');
  });

  it('rechaza modelos desconocidos listando los válidos', () => {
    let caught: M1Error | undefined;
    try {
      deriveClefModel('gpt-4o');
    } catch (error) {
      caught = error as M1Error;
    }

    expect(caught).toBeInstanceOf(M1Error);
    expect(caught?.code).toBe('E_CONFIG');
    expect(caught?.hint).toContain('@cf/cloudflare/clef-omni');
  });
});

describe('listModels: cloudflare', () => {
  it('consulta el catálogo real, mapea y completa datos conocidos', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        success: true,
        result: [
          {
            id: '@cf/cloudflare/clef-flash',
            name: 'Clef Flash',
            description: 'fast',
            properties: { context_window: 24_576 },
          },
          { id: '@cf/cloudflare/desconocido', name: 'Otro' },
        ],
      }),
    );

    const { models, warnings } = await listModels({
      kind: 'cloudflare',
      accountId: 'acc-1',
      apiKey: 'token-secreto',
    });

    expect(warnings).toEqual([]);
    // Sin `--search` sólo se listan modelos Clef: el resto no se puede ejecutar.
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: '@cf/cloudflare/clef-flash',
      source: 'api',
      contextWindow: 24_576,
      capabilities: { images: true },
    });

    const { url, init } = callOf(fetchMock);
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc-1/ai/models/search?search=clef',
    );
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-secreto' });
  });

  it('con búsqueda explícita devuelve también modelos fuera de Clef', async () => {
    stubFetch(() =>
      jsonResponse({
        result: [
          { id: '@cf/cloudflare/desconocido', name: 'Otro' },
        ],
      }),
    );

    const { models } = await listModels({
      kind: 'cloudflare',
      accountId: 'acc-1',
      apiKey: 't',
      search: 'desconocido',
    });

    expect(models.map((model) => model.id)).toEqual(['@cf/cloudflare/desconocido']);
  });

  it('pasa el texto de búsqueda en la query', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ result: [] }));

    await listModels({ kind: 'cloudflare', accountId: 'acc 1', apiKey: 't', search: 'clef omni' });

    expect(callOf(fetchMock).url).toContain(`search=${encodeURIComponent('clef omni')}`);
  });

  it('usa `name` como id cuando la API devuelve id UUID (forma real)', async () => {
    stubFetch(() =>
      jsonResponse({
        result: [
          {
            id: '87f39d62-116c-4b26-b2cd-562a9ba01f2f',
            name: '@cf/cloudflare/clef',
            description: 'decision model',
          },
        ],
      }),
    );

    const { models } = await listModels({ kind: 'cloudflare', accountId: 'acc-1', apiKey: 't' });

    expect(models[0]).toMatchObject({
      id: '@cf/cloudflare/clef',
      name: 'Clef',
      contextWindow: 65_536,
      inputPricePerMillion: 0.24,
      capabilities: { images: true },
      source: 'api',
    });
  });

  it.each([401, 429])('ante %i cae al catálogo estático sin filtrar el token', async (status) => {
    stubFetch(() => jsonResponse({ errors: [{ code: 10_000 }] }, status));

    const { models, warnings } = await listModels({
      kind: 'cloudflare',
      accountId: 'acc-1',
      apiKey: 'token-secreto',
    });

    expect(models).toEqual(staticModelsFor('cloudflare'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(String(status));
    expect(warnings.join(' ')).not.toContain('token-secreto');
  });

  it('sin credenciales no llama a fetch y devuelve el estático', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ result: [] }));

    const { models, warnings } = await listModels({ kind: 'cloudflare', accountId: 'acc-1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(models).toEqual(staticModelsFor('cloudflare'));
    expect(warnings[0]).toContain('credenciales');
  });
});

describe('listModels: typesafe', () => {
  it('consulta /v1/models y marca images=false', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ data: [{ id: 'jev-1.14.0', name: 'JEV 1.14.0' }] }),
    );

    const { models, warnings } = await listModels({ kind: 'typesafe', apiKey: 'ts-key' });

    expect(warnings).toEqual([]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'jev-1.14.0',
      source: 'api',
      capabilities: { images: false },
    });

    const { url, init } = callOf(fetchMock);
    expect(url).toBe('https://api.typesafe.ai/v1/models');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer ts-key' });
  });

  it('ante 401 cae al catálogo estático', async () => {
    stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));

    const { models, warnings } = await listModels({ kind: 'typesafe', apiKey: 'mala' });

    expect(models).toEqual(staticModelsFor('typesafe'));
    expect(warnings[0]).toContain('401');
  });
});

describe('listModels: openrouter', () => {
  it('consulta output_modalities=decisions y mapea precio/contexto/modalidades', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        data: [
          {
            id: 'typesafe/jev-1.14',
            name: 'TypeSafe: Jev 1.14',
            context_length: 262_144,
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['decisions'] },
            pricing: { prompt: '0.000000042', completion: '0' },
          },
          {
            id: 'baseten/mammoth-1:free',
            name: 'Baseten: Mammoth 1 (free)',
            context_length: 16_384,
            architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
            pricing: { prompt: '0', completion: '0' },
          },
        ],
      }),
    );

    const { models, warnings } = await listModels({ kind: 'openrouter', apiKey: 'or-key' });

    expect(warnings).toEqual([]);
    expect(models.map((model) => model.id)).toEqual([
      'typesafe/jev-1.14',
      'baseten/mammoth-1:free',
    ]);
    expect(models[0]).toMatchObject({
      provider: 'openrouter',
      contextWindow: 262_144,
      inputPricePerMillion: 0.042,
      capabilities: { images: true },
      source: 'api',
    });
    expect(models[1]).toMatchObject({
      inputPricePerMillion: 0,
      free: true,
      capabilities: { images: false },
    });

    const { url, init } = callOf(fetchMock);
    expect(url).toBe('https://openrouter.ai/api/v1/models?output_modalities=decisions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer or-key' });
  });

  it('deriva la URL de listado desde un baseUrl /systemone', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: [] }));

    await listModels({
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
    });

    expect(callOf(fetchMock).url).toBe(
      'https://openrouter.ai/api/v1/models?output_modalities=decisions',
    );
    // Sin key el catálogo es público: no manda Authorization.
    expect(callOf(fetchMock).init.headers).not.toMatchObject({
      Authorization: expect.any(String),
    });
  });

  it('con freeOnly deja sólo los modelos gratis', async () => {
    stubFetch(() =>
      jsonResponse({
        data: [
          {
            id: 'typesafe/jev-1.14',
            architecture: { input_modalities: ['text', 'image'] },
            pricing: { prompt: '0.000000042', completion: '0' },
          },
          {
            id: 'baseten/mammoth-1:free',
            architecture: { input_modalities: ['text'] },
            pricing: { prompt: '0', completion: '0' },
          },
        ],
      }),
    );

    const { models } = await listModels({ kind: 'openrouter', freeOnly: true });

    expect(models.map((model) => model.id)).toEqual(['baseten/mammoth-1:free']);
  });

  it('ante 403 cae al catálogo estático con warning', async () => {
    stubFetch(() => jsonResponse({ error: 'Access denied by security policy.' }, 403));

    const { models, warnings } = await listModels({ kind: 'openrouter' });

    expect(models).toEqual(staticModelsFor('openrouter'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('403');
  });
});

describe('listModels: systemone', () => {
  it('capacidades desconocidas y catálogo vacío si el endpoint falla', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    const { models, warnings } = await listModels({
      kind: 'systemone',
      baseUrl: 'http://localhost:9/v1/systemone',
    });

    expect(capabilitiesFor('systemone', 'local-decision')).toBeUndefined();
    expect(models).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it('si el endpoint responde, mapea strings u objetos', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ data: ['local-a', { id: 'local-b' }] }));

    const { models, warnings } = await listModels({
      kind: 'systemone',
      baseUrl: 'http://localhost:8000/v1/systemone/',
    });

    expect(warnings).toEqual([]);
    expect(models.map((model) => model.id)).toEqual(['local-a', 'local-b']);
    expect(callOf(fetchMock).url).toBe('http://localhost:8000/v1/systemone/models');
  });
});

describe('listModels: mock', () => {
  it('devuelve el catálogo fijo sin red', async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));

    const { models, warnings } = await listModels({ kind: 'mock' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    expect(models.map((model) => model.id)).toEqual(['mock']);
  });
});
