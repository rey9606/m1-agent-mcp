import { describe, expect, it } from 'vitest';

import { loadDotEnv } from '../../src/config/config';
import { resolveSecrets } from '../../src/config/credentials';
import { M1Error } from '../../src/core/errors';
import { createProvider } from '../../src/providers/registry';

/**
 * Test live contra Cloudflare Workers AI.
 * Sólo corre con `pnpm test:live` (M1_LIVE=1); en CI/local queda skipped.
 */

const LIVE = process.env.M1_LIVE === '1';

describe.skipIf(!LIVE)('cloudflare live (clef-flash)', () => {
  it('responde noul y score con el contrato esperado', async () => {
    loadDotEnv();
    const cfg = { kind: 'cloudflare' as const, model: '@cf/cloudflare/clef-flash' };
    const secrets = resolveSecrets('cf', cfg);
    if (!secrets.apiKey || !secrets.accountId) {
      throw new Error('faltan CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN en .env');
    }

    const provider = createProvider('cf', { ...cfg, ...secrets });

    try {
      const response = await provider.evaluate(
        {
          model: '@cf/cloudflare/clef-flash',
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
        { signal: AbortSignal.timeout(30_000) },
      );

      const noul = response.answers['LIVE-1'];
      const score = response.answers['LIVE-2'];
      expect(noul?.type).toBe('noul');
      expect(score?.type).toBe('score');
      if (noul?.type === 'noul') expect(noul.noul).toBeGreaterThan(0.5);
      if (score?.type === 'score') {
        expect(score.score).toBeGreaterThanOrEqual(0);
        expect(score.score).toBeLessThanOrEqual(2);
      }
    } catch (error) {
      if (error instanceof M1Error && /429/.test(error.message)) {
        throw new Error(
          'Cloudflare devolvió 429 (cuota diaria de neurons agotada). Reintentá cuando se renueve la cuota.',
          { cause: error },
        );
      }
      throw error;
    }
  }, 45_000);
});
