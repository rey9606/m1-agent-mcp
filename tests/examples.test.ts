import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runRecipe, type EngineDeps, type EngineEvent } from '../src/core/engine';
import { collectRefs } from '../src/core/expr';
import { validateRecipe, type RecipeValidation } from '../src/core/validate';
import { createMockProvider } from '../src/providers/mock';
import type {
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
} from '../src/providers/types';
import type { ResolvedRecipe } from '../src/schema/recipe';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXAMPLES_DIR = fileURLToPath(new URL('../examples', import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/mock', import.meta.url));

/** PNG real de 1x1 para ejercitar la carga de imágenes sin binarios en el repo. */
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function loadRecipe(name: string): RecipeValidation {
  const filePath = join(EXAMPLES_DIR, `${name}.json`);
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  return validateRecipe(raw, { filePath, defaultId: name });
}

/** Provider fake que falla si el motor intenta llamarlo (dry-run no debe hacer red). */
function throwingProvider(): DecisionProvider {
  return {
    name: 'fake',
    kind: 'mock',
    async evaluate(): Promise<DecisionResponse> {
      throw new Error('dry-run no debe llamar al provider');
    },
  };
}

/** Recoge los requests que el motor emite en `stage:end` (dry-run). */
function captureRequests(): { requests: DecisionRequest[]; onEvent: (event: EngineEvent) => void } {
  const requests: DecisionRequest[] = [];
  return {
    requests,
    onEvent: (event) => {
      if (event.type !== 'stage:end') return;
      const detail = event.detail as { request?: DecisionRequest } | undefined;
      if (detail?.request) requests.push(detail.request);
    },
  };
}

function makeDeps(provider: DecisionProvider, overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    provider,
    providerName: 'fake',
    model: 'fake-model',
    ...overrides,
  };
}

function knownRef(ref: string, known: Set<string>): boolean {
  if (known.has(ref)) return true;
  for (const id of known) {
    if (ref.startsWith(`${id}.`)) return true;
  }
  return false;
}

/**
 * Invariantes semánticas que `validateRecipe` ya exige; se repiten acá para que
 * una regresión en los ejemplos (o en el validador) rompa este test explícito.
 */
function checkSemanticInvariants(recipe: ResolvedRecipe): void {
  const criterionIds = new Set(recipe.criteria.map((c) => c.id));
  const derivedIds = new Set(recipe.derived.map((d) => d.id));
  const known = new Set([...criterionIds, ...derivedIds]);
  const asked = new Set<string>();

  for (const stage of recipe.stages) {
    for (const questionId of stage.questions) {
      expect(criterionIds.has(questionId), `etapa "${stage.id}" pregunta "${questionId}" inexistente`).toBe(true);
      asked.add(questionId);
    }
    if (stage.when) {
      for (const ref of collectRefs(stage.when)) {
        if (['true', 'false', 'null', 'undefined'].includes(ref)) continue;
        expect(knownRef(ref, known), `when de "${stage.id}" referencia "${ref}" inexistente`).toBe(true);
      }
    }
  }

  for (const criterion of recipe.criteria) {
    expect(asked.has(criterion.id), `criterio "${criterion.id}" no se pregunta en ninguna etapa`).toBe(true);

    if (criterion.type === 'score') {
      expect(Array.isArray(criterion.criteria), `score "${criterion.id}" requiere niveles`).toBe(true);
      const levels = (criterion.criteria as unknown[]).length;
      expect(levels, `score "${criterion.id}" debe tener 2..10 niveles`).toBeGreaterThanOrEqual(2);
      expect(levels, `score "${criterion.id}" debe tener 2..10 niveles`).toBeLessThanOrEqual(10);
    }

    if (criterion.type === 'choice') {
      const options = Object.keys(criterion.criteria as Record<string, unknown>);
      expect(options.length, `choice "${criterion.id}" debe tener 2..255 opciones`).toBeGreaterThanOrEqual(2);
      expect(options.length, `choice "${criterion.id}" debe tener 2..255 opciones`).toBeLessThanOrEqual(255);
      for (const key of Object.keys(criterion.mapping ?? {})) {
        expect(options, `mapping de "${criterion.id}" referencia "${key}" inexistente`).toContain(key);
      }
    }
  }

  for (const derived of recipe.derived) {
    for (const ref of collectRefs(derived.expr)) {
      expect(knownRef(ref, known), `derived "${derived.id}" referencia "${ref}" inexistente`).toBe(true);
    }
  }

  for (const acceptance of recipe.acceptance) {
    for (const ref of collectRefs(acceptance.expr)) {
      expect(knownRef(ref, known), `acceptance "${acceptance.id}" referencia "${ref}" inexistente`).toBe(true);
    }
  }
}

function fixtureProvider(): DecisionProvider {
  return createMockProvider('mock', { kind: 'mock', fixturesDir: FIXTURES_DIR });
}

// ---------------------------------------------------------------------------
// Validación de las recetas de ejemplo
// ---------------------------------------------------------------------------

describe('examples', () => {
  it('ux-checker.json valida sin errores ni warnings', () => {
    const { recipe, warnings } = loadRecipe('ux-checker');
    expect(recipe.id).toBe('ux-checker');
    expect(warnings).toEqual([]);
    expect(recipe.criteria.map((c) => c.id)).toEqual(['UX-1', 'UX-2', 'UX-3', 'UX-4', 'UX-5']);
    expect(recipe.stages.map((s) => s.id)).toEqual(['base', 'diagnostico']);
  });

  it('copy-checker.json valida sin errores ni warnings', () => {
    const { recipe, warnings } = loadRecipe('copy-checker');
    expect(recipe.id).toBe('copy-checker');
    expect(warnings).toEqual([]);
    expect(recipe.criteria.map((c) => c.id)).toEqual([
      'CP-1',
      'CP-2',
      'CP-3',
      'CP-4',
      'CP-5',
      'CP-6',
    ]);
    expect(recipe.stages.map((s) => s.id)).toEqual(['base', 'diagnostico']);
  });

  it('ambas recetas cumplen las invariantes semánticas', () => {
    for (const name of ['ux-checker', 'copy-checker']) {
      const { recipe } = loadRecipe(name);
      checkSemanticInvariants(recipe);
    }
  });
});

// ---------------------------------------------------------------------------
// Dry-run: qué requests genera el motor
// ---------------------------------------------------------------------------

describe('dry-run de las recetas', () => {
  it('ux-checker genera 2 requests, incluida la etapa condicional con hallazgos', async () => {
    const { recipe } = loadRecipe('ux-checker');
    const captured = captureRequests();

    const result = await runRecipe({
      recipe,
      input: { screens: ['ignorado.png'] },
      deps: makeDeps(throwingProvider(), {
        onEvent: captured.onEvent,
        resolveInput: async () => ({
          vars: { brief: 'Brief de prueba', screens: [] },
          imagesBySlot: {},
        }),
      }),
      options: { dryRun: true },
    });

    // dry-run fuerza todas las etapas, incluso con `when` falso potencial.
    expect(captured.requests).toHaveLength(2);
    expect(result.trace?.map((t) => t.id)).toEqual(['base', 'diagnostico']);

    const [base, diagnostico] = captured.requests;
    expect(Object.keys(base!.questions)).toEqual(['UX-1', 'UX-2', 'UX-3', 'UX-4']);
    expect(base!.questions['UX-1']).toMatchObject({ type: 'score' });
    expect(base!.questions['UX-2']).toMatchObject({ type: 'noul' });
    expect(base!.questions['UX-3']).toMatchObject({ type: 'choice' });

    expect(Object.keys(diagnostico!.questions)).toEqual(['UX-5']);
    expect(diagnostico!.state).toMatchObject({
      brief: 'Brief de prueba',
      hallazgos: { jerarquia: 0.5, contraste: 0.5 },
    });
  });

  it('ux-checker incluye la imagen cargada con content_type image/png', async () => {
    const { recipe } = loadRecipe('ux-checker');
    const captured = captureRequests();
    const dir = mkdtempSync(join(tmpdir(), 'm1-examples-'));
    const imagePath = join(dir, 'screen.png');
    writeFileSync(imagePath, Buffer.from(PNG_1X1_BASE64, 'base64'));

    try {
      await runRecipe({
        recipe,
        input: { screens: [imagePath] },
        deps: makeDeps(throwingProvider(), { onEvent: captured.onEvent }),
        options: { dryRun: true },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(captured.requests).toHaveLength(2);
    const base = captured.requests[0]!;
    expect(base.images).toHaveLength(1);
    expect(base.images?.[0]).toMatchObject({
      content_type: 'image/png',
      base64: PNG_1X1_BASE64,
    });
    // La imagen se aplica también a la etapa de diagnóstico (input.images global).
    expect(captured.requests[1]!.images).toHaveLength(1);
  });

  it('copy-checker renderiza el texto del slot copy en el state', async () => {
    const { recipe } = loadRecipe('copy-checker');
    const captured = captureRequests();
    const copy = 'Este es el texto de copy bajo evaluación.';

    const result = await runRecipe({
      recipe,
      input: { copy },
      deps: makeDeps(throwingProvider(), {
        onEvent: captured.onEvent,
        resolveInput: async () => ({ vars: { copy, brief: '' }, imagesBySlot: {} }),
      }),
      options: { dryRun: true },
    });

    expect(captured.requests).toHaveLength(2);
    expect(captured.requests[0]!.state).toMatchObject({ copy, brief: '' });
    expect(Object.keys(captured.requests[0]!.questions)).toEqual([
      'CP-1',
      'CP-2',
      'CP-3',
      'CP-4',
      'CP-5',
    ]);
    expect(Object.keys(captured.requests[1]!.questions)).toEqual(['CP-6']);
    expect(result.meta.calls).toBe(0);
    expect(result.meta.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fixtures del provider mock: verifican los veredictos esperados
// ---------------------------------------------------------------------------

describe('fixtures/mock/answers.json', () => {
  it('copy-checker da verdict pass y ninguna issue con las respuestas fijadas', async () => {
    const { recipe } = loadRecipe('copy-checker');
    const copy = 'Texto de prueba para el fixture del mock.';

    const result = await runRecipe({
      recipe,
      input: { copy },
      deps: makeDeps(fixtureProvider(), {
        resolveInput: async () => ({ vars: { copy, brief: '' }, imagesBySlot: {} }),
      }),
    });

    expect(result.verdict).toBe('pass');
    expect(result.issues).toEqual([]);
    expect(result.acceptance.every((a) => a.passed)).toBe(true);
    // CP-2 = on_brand → el `when` de diagnóstico es falso: una sola llamada.
    expect(result.meta.calls).toBe(1);
    expect(result.trace?.find((t) => t.id === 'diagnostico')).toMatchObject({
      status: 'skipped',
      reason: 'when=false',
    });
  });

  it('ux-checker da verdict fail con un issue de contraste (UX-2)', async () => {
    const { recipe } = loadRecipe('ux-checker');

    const result = await runRecipe({
      recipe,
      input: { screens: ['ignorado.png'] },
      deps: makeDeps(fixtureProvider(), {
        resolveInput: async () => ({ vars: { brief: '', screens: [] }, imagesBySlot: {} }),
      }),
    });

    expect(result.verdict).toBe('fail');

    const contrast = result.issues.find((issue) => issue.criterion === 'UX-2');
    expect(contrast).toMatchObject({ criterion: 'UX-2', severity: 'blocker' });
    expect(contrast?.message).toContain('Contraste AA');
    expect(contrast?.remediation).toBeTruthy();

    expect(result.acceptance.find((a) => a.id === 'A1')).toMatchObject({
      passed: false,
      severity: 'blocker',
    });
    // UX-2 < 0.7 → se ejecuta la etapa de diagnóstico (2 llamadas).
    expect(result.meta.calls).toBe(2);
    expect(result.trace?.every((t) => t.status === 'ran')).toBe(true);
  });
});
