import { describe, expect, it } from 'vitest';

import { loadDotEnv } from '../../src/config/config';
import { resolveSecrets } from '../../src/config/credentials';
import { listModels } from '../../src/providers/models';
import { createProvider } from '../../src/providers/registry';

/**
 * Test live contra OpenRouter (superficie System One).
 * Sólo corre con `pnpm test:live` (M1_LIVE=1) y si hay OPENROUTER_KEY.
 * Modelo configurable con M1_LIVE_OPENROUTER_MODEL (default: un free).
 */

loadDotEnv();

const LIVE = process.env.M1_LIVE === '1';
const KEY = process.env.OPENROUTER_KEY;
const MODEL = process.env.M1_LIVE_OPENROUTER_MODEL ?? 'baseten/mammoth-1:free';

describe.skipIf(!LIVE || !KEY)('openrouter live', () => {
  it(`evalúa una decisión con ${MODEL}`, async () => {
    const cfg = { kind: 'openrouter' as const, model: MODEL };
    const secrets = resolveSecrets('or', cfg);
    const provider = createProvider('or', { ...cfg, ...secrets });

    const response = await provider.evaluate(
      {
        model: MODEL,
        state: 'Texto de prueba: "Hola, esto es una prueba."',
        questions: {
          'LIVE-1': { type: 'noul', instructions: '¿El texto no está vacío?' },
          'LIVE-2': {
            type: 'score',
            instructions: '¿Qué tan claro es el texto?',
            criteria: ['confuso', 'aceptable', 'claro'],
          },
        },
      },
      { signal: AbortSignal.timeout(60_000) },
    );

    expect(response.answers['LIVE-1']).toMatchObject({ type: 'noul' });
    expect(typeof (response.answers['LIVE-1'] as { noul: number }).noul).toBe('number');
    expect(response.answers['LIVE-2']).toMatchObject({ type: 'score' });
  }, 90_000);

  it('lista el catálogo de decisiones y marca los free', async () => {
    const { models, warnings } = await listModels({
      kind: 'openrouter',
      apiKey: KEY,
      freeOnly: true,
    });

    expect(warnings).toEqual([]);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.free === true)).toBe(true);
  }, 60_000);
});
