import { describe, expect, it } from 'vitest';

import { runRecipe, type EngineDeps } from '../src/core/engine';
import { M1Error } from '../src/core/errors';
import { validateRecipe } from '../src/core/validate';
import type { LoadedImage } from '../src/intake/images';
import type { Answer, DecisionProvider, DecisionRequest, DecisionResponse } from '../src/providers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function image(base64 = 'AAAA'): LoadedImage {
  return { content_type: 'image/png', base64, bytes: 3, source: 'inline' };
}

function noul(value: number): Answer {
  return { type: 'noul', noul: value };
}

function makeProvider(
  answerFor: (id: string) => Answer | undefined,
  opts: { fail?: Error } = {},
): { provider: DecisionProvider; requests: DecisionRequest[] } {
  const requests: DecisionRequest[] = [];
  const provider: DecisionProvider = {
    name: 'fake',
    kind: 'mock',
    async evaluate(request: DecisionRequest): Promise<DecisionResponse> {
      requests.push(request);
      if (opts.fail) throw opts.fail;
      const answers: Record<string, Answer> = {};
      for (const id of Object.keys(request.questions)) {
        const answer = answerFor(id);
        if (answer) answers[id] = answer;
      }
      return {
        model: 'fake-model',
        answers,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    },
  };
  return { provider, requests };
}

function makeDeps(provider: DecisionProvider, overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    provider,
    providerName: 'fake',
    model: 'fake-model',
    resolveInput: async () => ({ vars: {}, imagesBySlot: {} }),
    ...overrides,
  };
}

async function expectM1(fn: () => unknown, code: string): Promise<M1Error> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(M1Error);
    const err = error as M1Error;
    expect(err.code).toBe(code);
    return err;
  }
  throw new Error(`se esperaba un M1Error con code ${code}`);
}

const threeCriteria = {
  id: 'demo',
  role: 'tester',
  criteria: [
    { id: 'a', name: 'A', type: 'noul', instructions: '¿A?' },
    { id: 'b', name: 'B', type: 'noul', instructions: '¿B?' },
    { id: 'c', name: 'C', type: 'noul', instructions: '¿C?' },
  ],
  stages: [{ id: 's1', questions: ['a', 'b', 'c'] }],
};

// ---------------------------------------------------------------------------
// runRecipe
// ---------------------------------------------------------------------------

describe('runRecipe', () => {
  it('una etapa con 3 criterios normaliza, pondera y da pass', async () => {
    const recipe = validateRecipe(threeCriteria).recipe;
    const { provider } = makeProvider(() => noul(0.9));

    const result = await runRecipe({
      recipe,
      input: {},
      deps: makeDeps(provider),
    });

    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(90);
    expect(result.criteria).toHaveLength(3);
    expect(result.criteria.every((c) => c.stage === 's1')).toBe(true);
    expect(result.criteria.map((c) => c.normalized)).toEqual([0.9, 0.9, 0.9]);
    expect(result.criteria.every((c) => c.passed)).toBe(true);
    expect(result.meta.calls).toBe(1);
    expect(result.meta.inputTokens).toBe(10);
    expect(result.meta.outputTokens).toBe(5);
    expect(result.runId).toMatch(/^run_[0-9a-f]{12}$/);
    expect(result.trace?.[0]).toMatchObject({ id: 's1', status: 'ran' });
  });

  it('propaga passAt al resultado y al mensaje del issue', async () => {
    const recipe = validateRecipe({
      id: 'passat',
      role: 'tester',
      criteria: [{ id: 'a', name: 'A', type: 'noul', instructions: '¿A?', passAt: 0.9 }],
      stages: [{ id: 's1', questions: ['a'] }],
    }).recipe;
    const { provider } = makeProvider(() => noul(0.82));

    const result = await runRecipe({ recipe, input: {}, deps: makeDeps(provider) });

    expect(result.criteria[0]?.passAt).toBe(0.9);
    expect(result.criteria[0]?.passed).toBe(false);
    expect(result.issues[0]?.message).toContain('< 0.90');
  });

  it('saltea una etapa con when falso sin llamar al provider', async () => {
    const recipe = validateRecipe({
      id: 'when-false',
      role: 'tester',
      criteria: [
        { id: 'a', type: 'noul', instructions: '¿A?' },
        { id: 'b', type: 'noul', instructions: '¿B?' },
      ],
      stages: [
        { id: 's1', questions: ['a'] },
        { id: 's2', questions: ['b'], when: 'a > 0.5' },
      ],
    }).recipe;

    const { provider, requests } = makeProvider(() => noul(0.1));

    const result = await runRecipe({ recipe, input: {}, deps: makeDeps(provider) });

    expect(requests).toHaveLength(1);
    expect(result.meta.calls).toBe(1);
    const skipped = result.trace?.find((t) => t.id === 's2');
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'when=false' });
    expect(result.criteria.map((c) => c.id)).toEqual(['a']);
  });

  it('con when verdadero llama dos veces y renderiza el state con answers', async () => {
    const recipe = validateRecipe({
      id: 'when-true',
      role: 'tester',
      criteria: [
        { id: 'a', type: 'noul', instructions: '¿A?' },
        { id: 'b', type: 'noul', instructions: '¿B?' },
      ],
      stages: [
        { id: 's1', questions: ['a'] },
        { id: 's2', questions: ['b'], when: 'a >= 0.5', state: { previo: '{{answers.a.noul}}' } },
      ],
    }).recipe;

    const { provider, requests } = makeProvider(() => noul(0.8));

    const result = await runRecipe({ recipe, input: {}, deps: makeDeps(provider) });

    expect(requests).toHaveLength(2);
    expect(result.meta.calls).toBe(2);
    expect(requests[1]?.state).toEqual({ previo: 0.8 });
    expect(result.criteria.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('un acceptance blocker fallado produce fail', async () => {
    const recipe = validateRecipe({
      ...threeCriteria,
      acceptance: [{ id: 'acc', expr: 'a >= 0.95', severity: 'blocker' }],
    }).recipe;

    const { provider } = makeProvider(() => noul(0.9));

    const result = await runRecipe({ recipe, input: {}, deps: makeDeps(provider) });

    expect(result.verdict).toBe('fail');
    expect(result.acceptance).toHaveLength(1);
    expect(result.acceptance[0]).toMatchObject({ id: 'acc', passed: false, severity: 'blocker' });
  });

  it('evalúa derived en orden y acceptance puede referenciarlo', async () => {
    const recipe = validateRecipe({
      id: 'derived',
      role: 'tester',
      criteria: [{ id: 'a', type: 'noul', instructions: '¿A?' }],
      stages: [{ id: 's1', questions: ['a'] }],
      derived: [{ id: 'dbl', expr: 'a * 2' }],
      acceptance: [{ id: 'acc', expr: 'dbl >= 1.5', severity: 'major' }],
    }).recipe;

    const { provider } = makeProvider(() => noul(0.9));

    const result = await runRecipe({ recipe, input: {}, deps: makeDeps(provider) });

    expect(result.derived.dbl).toBeCloseTo(1.8);
    expect(result.acceptance[0]?.passed).toBe(true);
    expect(result.verdict).toBe('pass');
  });

  it('incluye las imágenes del slot configurado en el request', async () => {
    const recipe = validateRecipe({
      id: 'img',
      role: 'tester',
      input: { slots: { shot: { type: 'image' } }, images: ['shot'] },
      criteria: [{ id: 'a', type: 'noul', instructions: '¿A?' }],
      stages: [{ id: 's1', questions: ['a'] }],
    }).recipe;

    const { provider, requests } = makeProvider(() => noul(0.9));
    const shot = image();

    const result = await runRecipe({
      recipe,
      input: { shot: 'ignorado.png' },
      deps: makeDeps(provider, {
        resolveInput: async () => ({ vars: {}, imagesBySlot: { shot: [shot] } }),
      }),
    });

    expect(requests[0]?.images).toEqual([{ content_type: 'image/png', base64: 'AAAA' }]);
    expect(result.verdict).toBe('pass');
  });

  it('falla con E_CONFIG antes de llamar si el provider no soporta imágenes', async () => {
    const recipe = validateRecipe({
      id: 'img-novision',
      role: 'tester',
      input: { slots: { shot: { type: 'image' } }, images: ['shot'] },
      criteria: [{ id: 'a', type: 'noul', instructions: '¿A?' }],
      stages: [{ id: 's1', questions: ['a'] }],
    }).recipe;

    const { provider, requests } = makeProvider(() => noul(0.9));
    const noVision: DecisionProvider = { ...provider, capabilities: { images: false } };

    const err = await expectM1(
      () =>
        runRecipe({
          recipe,
          input: { shot: 'ignorado.png' },
          deps: makeDeps(noVision, {
            resolveInput: async () => ({ vars: {}, imagesBySlot: { shot: [image()] } }),
          }),
        }),
      'E_CONFIG',
    );

    expect(err.message).toContain('fake-model');
    expect(err.message).toContain('fake');
    expect(err.hint).toContain('--image');
    expect(requests).toHaveLength(0);
  });

  it('envuelve errores del provider en E_PROVIDER con el id de etapa', async () => {
    const recipe = validateRecipe(threeCriteria).recipe;
    const { provider } = makeProvider(() => noul(0.9), { fail: new Error('boom') });

    const err = await expectM1(
      () => runRecipe({ recipe, input: {}, deps: makeDeps(provider) }),
      'E_PROVIDER',
    );

    expect(err.message).toContain('s1');
    expect(err.message).toContain('boom');
  });

  it('dryRun no llama al provider y marca meta.dryRun', async () => {
    const recipe = validateRecipe(threeCriteria).recipe;
    const { provider, requests } = makeProvider(() => noul(0.9));

    const result = await runRecipe({
      recipe,
      input: {},
      deps: makeDeps(provider),
      options: { dryRun: true },
    });

    expect(requests).toHaveLength(0);
    expect(result.meta.dryRun).toBe(true);
    expect(result.meta.calls).toBe(0);
    expect(result.verdict).toBe('fail');
    expect(result.criteria).toHaveLength(0);
    expect(result.trace?.[0]).toMatchObject({ id: 's1', status: 'ran', durationMs: 0 });
  });

  it('falla con E_PROVIDER si el provider omite una respuesta', async () => {
    const recipe = validateRecipe(threeCriteria).recipe;
    const { provider } = makeProvider((id) => (id === 'b' ? undefined : noul(0.9)));

    const err = await expectM1(
      () => runRecipe({ recipe, input: {}, deps: makeDeps(provider) }),
      'E_PROVIDER',
    );

    expect(err.message).toContain('b');
    expect(err.message).toContain('s1');
  });
});

// ---------------------------------------------------------------------------
// validateRecipe
// ---------------------------------------------------------------------------

describe('validateRecipe', () => {
  it('acepta una receta válida y resuelve el id', () => {
    const { recipe, warnings } = validateRecipe(threeCriteria);
    expect(recipe.id).toBe('demo');
    expect(recipe.criteria).toHaveLength(3);
    expect(warnings).toEqual([]);
  });

  it('resuelve el id desde defaultId o filePath', () => {
    const raw = { ...threeCriteria, id: undefined };
    expect(validateRecipe(raw, { defaultId: 'fallback' }).recipe.id).toBe('fallback');
    expect(validateRecipe(raw, { filePath: '/tmp/mi.receta.json' }).recipe.id).toBe('mi.receta');
  });

  it('error con todos los ids de criterio duplicados', () => {
    const raw = {
      ...threeCriteria,
      criteria: [
        { id: 'a', type: 'noul', instructions: '¿A?' },
        { id: 'a', type: 'noul', instructions: '¿A otra vez?' },
      ],
      stages: [{ id: 's1', questions: ['a'] }],
    };

    let caught: M1Error | undefined;
    try {
      validateRecipe(raw);
    } catch (e) {
      caught = e as M1Error;
    }
    expect(caught).toBeInstanceOf(M1Error);
    expect(caught?.code).toBe('E_VALIDATION');
    const details = caught?.details as Array<{ path: string; message: string }>;
    expect(details.some((d) => d.path === 'criteria.1.id' && d.message.includes('duplicado'))).toBe(true);
  });

  it('error si acceptance referencia un valor inexistente', () => {
    const raw = {
      ...threeCriteria,
      acceptance: [{ id: 'acc', expr: 'inexistente > 0.5', severity: 'major' }],
    };

    let caught: M1Error | undefined;
    try {
      validateRecipe(raw);
    } catch (e) {
      caught = e as M1Error;
    }
    expect(caught?.code).toBe('E_VALIDATION');
    const details = caught?.details as Array<{ path: string; message: string }>;
    expect(details.some((d) => d.path === 'acceptance.0.expr' && d.message.includes('inexistente'))).toBe(true);
  });

  it('error si when no parsea', () => {
    const raw = {
      ...threeCriteria,
      stages: [{ id: 's1', questions: ['a', 'b', 'c'], when: 'a >' }],
    };

    let caught: M1Error | undefined;
    try {
      validateRecipe(raw);
    } catch (e) {
      caught = e as M1Error;
    }
    expect(caught?.code).toBe('E_VALIDATION');
    const details = caught?.details as Array<{ path: string; message: string }>;
    expect(details.some((d) => d.path === 'stages.0.when')).toBe(true);
  });

  it('error si se excede limits.maxStages', () => {
    const raw = {
      id: 'stages',
      role: 'tester',
      limits: { maxStages: 1 },
      criteria: [
        { id: 'a', type: 'noul', instructions: '¿A?' },
        { id: 'b', type: 'noul', instructions: '¿B?' },
      ],
      stages: [
        { id: 's1', questions: ['a'] },
        { id: 's2', questions: ['b'] },
      ],
    };

    let caught: M1Error | undefined;
    try {
      validateRecipe(raw);
    } catch (e) {
      caught = e as M1Error;
    }
    expect(caught?.code).toBe('E_VALIDATION');
    const details = caught?.details as Array<{ path: string; message: string }>;
    expect(details.some((d) => d.path === 'stages')).toBe(true);
  });

  it('advierte por criterios que nunca se preguntan', () => {
    const raw = {
      ...threeCriteria,
      stages: [{ id: 's1', questions: ['a', 'b'] }],
    };
    const { warnings } = validateRecipe(raw);
    expect(warnings.some((w) => w.includes('"c"'))).toBe(true);
  });

  it('error si input.images referencia un slot que no es imagen', () => {
    const raw = {
      id: 'img-slot',
      role: 'tester',
      input: { slots: { texto: { type: 'text' } }, images: ['texto'] },
      criteria: [{ id: 'a', type: 'noul', instructions: '¿A?' }],
      stages: [{ id: 's1', questions: ['a'] }],
    };

    let caught: M1Error | undefined;
    try {
      validateRecipe(raw);
    } catch (e) {
      caught = e as M1Error;
    }
    expect(caught?.code).toBe('E_VALIDATION');
    const details = caught?.details as Array<{ path: string; message: string }>;
    expect(details.some((d) => d.path === 'input.images.0')).toBe(true);
  });
});
