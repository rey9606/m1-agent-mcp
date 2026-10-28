import { describe, expect, it } from 'vitest';
import {
  SEVERITY_ORDER,
  buildIssues,
  decideVerdict,
  evaluateAcceptance,
  weightedScore,
} from '../src/core/aggregate';
import { M1Error } from '../src/core/errors';
import { clamp01, normalizeAnswer } from '../src/core/normalize';
import { criterionSchema } from '../src/schema/recipe';
import type { Criterion } from '../src/schema/recipe';
import type { AcceptanceResult, CriterionResult } from '../src/schema/result';

const noul = (opts: Record<string, unknown> = {}): Criterion =>
  criterionSchema.parse({ id: 'q.noul', type: 'noul', instructions: 'x', ...opts });

const choice = (opts: Record<string, unknown> = {}): Criterion =>
  criterionSchema.parse({
    id: 'q.choice',
    type: 'choice',
    instructions: 'x',
    criteria: { yes: 'Sí', no: 'No' },
    ...opts,
  });

const score = (levels: unknown[], opts: Record<string, unknown> = {}): Criterion =>
  criterionSchema.parse({ id: 'q.score', type: 'score', instructions: 'x', criteria: levels, ...opts });

function res(partial: Partial<CriterionResult> & Pick<CriterionResult, 'id'>): CriterionResult {
  return {
    type: 'noul',
    stage: 's1',
    raw: 0,
    normalized: 0,
    passed: true,
    weight: 1,
    severity: 'major',
    ...partial,
  };
}

function withPassAt(r: CriterionResult, passAt: number): CriterionResult {
  return Object.assign({}, r, { passAt });
}

describe('clamp01', () => {
  it('clampea al rango 0..1', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('normalizeAnswer / noul', () => {
  it('noul positive devuelve la probabilidad y pasa el umbral', () => {
    const out = normalizeAnswer(noul(), { type: 'noul', noul: 0.8 });
    expect(out.raw).toBe(0.8);
    expect(out.normalized).toBe(0.8);
    expect(out.passed).toBe(true);
    expect(out.confidence).toBeUndefined();
  });

  it('noul negative invierte el valor', () => {
    const out = normalizeAnswer(noul({ polarity: 'negative' }), { type: 'noul', noul: 0.8 });
    expect(out.raw).toBe(0.8);
    expect(out.normalized).toBeCloseTo(0.2);
    expect(out.passed).toBe(false);
  });

  it('noul clampea valores fuera de rango en raw', () => {
    expect(normalizeAnswer(noul(), { type: 'noul', noul: 1.7 }).raw).toBe(1);
    expect(normalizeAnswer(noul(), { type: 'noul', noul: -0.3 }).raw).toBe(0);
  });

  it('usa el umbral exacto: normalized === passAt pasa', () => {
    const out = normalizeAnswer(noul({ passAt: 0.5 }), { type: 'noul', noul: 0.5 });
    expect(out.passed).toBe(true);
    const below = normalizeAnswer(noul({ passAt: 0.5 }), { type: 'noul', noul: 0.4999 });
    expect(below.passed).toBe(false);
  });
});

describe('normalizeAnswer / choice', () => {
  it('choice usa mapping cuando existe', () => {
    const out = normalizeAnswer(choice({ mapping: { yes: 0.9, no: 0.1 } }), {
      type: 'choice',
      choice: 'yes',
      probabilities: { yes: 0.3, no: 0.7 },
      confidence: 0.95,
    });
    expect(out.raw).toBe('yes');
    expect(out.normalized).toBe(0.9);
    expect(out.passed).toBe(true);
    expect(out.confidence).toBe(0.95);
    expect(out.probabilities).toEqual({ yes: 0.3, no: 0.7 });
  });

  it('choice sin mapping usa probabilities[choice]', () => {
    const out = normalizeAnswer(choice(), {
      type: 'choice',
      choice: 'no',
      probabilities: { yes: 0.2, no: 0.8 },
      confidence: 0.7,
    });
    expect(out.normalized).toBe(0.8);
  });

  it('choice no mapeada cae a 0 si no hay probabilidad', () => {
    const out = normalizeAnswer(choice({ mapping: { yes: 0.9 } }), {
      type: 'choice',
      choice: 'no',
      probabilities: { yes: 0.6 },
      confidence: 0.5,
    });
    expect(out.normalized).toBe(0);
    expect(out.passed).toBe(false);
  });

  it('choice con polaridad negativa invierte el mapping', () => {
    const out = normalizeAnswer(choice({ polarity: 'negative', mapping: { yes: 0.9, no: 0.1 } }), {
      type: 'choice',
      choice: 'no',
      probabilities: { yes: 0.1, no: 0.9 },
      confidence: 0.9,
    });
    expect(out.normalized).toBe(0.9);
  });
});

describe('normalizeAnswer / score', () => {
  it('score con 3 niveles normaliza por niveles-1', () => {
    const out = normalizeAnswer(score(['bajo', 'medio', 'alto']), {
      type: 'score',
      score: 2,
      probabilities: { bajo: 0.1, medio: 0.2, alto: 0.7 },
      confidence: 0.8,
      legend: { alto: 'cumple' },
    });
    expect(out.raw).toBe(2);
    expect(out.normalized).toBe(1);
    expect(out.confidence).toBe(0.8);
    expect(out.legend).toEqual({ alto: 'cumple' });
  });

  it('score fraccionario con 3 niveles', () => {
    const out = normalizeAnswer(score(['bajo', 'medio', 'alto']), {
      type: 'score',
      score: 0.67,
      probabilities: {},
      confidence: 0.6,
    });
    expect(out.normalized).toBeCloseTo(0.335);
  });

  it('score con 5 niveles normaliza por 4', () => {
    const out = normalizeAnswer(score(['a', 'b', 'c', 'd', 'e']), {
      type: 'score',
      score: 2,
      probabilities: {},
      confidence: 0.6,
    });
    expect(out.normalized).toBe(0.5);
  });

  it('score fuera de rango se clampea a 1', () => {
    const out = normalizeAnswer(score(['bajo', 'medio', 'alto']), {
      type: 'score',
      score: 9,
      probabilities: {},
      confidence: 0.9,
    });
    expect(out.normalized).toBe(1);
    expect(out.raw).toBe(9);
  });

  it('score con polaridad negativa invierte el resultado', () => {
    const out = normalizeAnswer(score(['bajo', 'medio', 'alto'], { polarity: 'negative' }), {
      type: 'score',
      score: 2,
      probabilities: {},
      confidence: 0.9,
    });
    expect(out.normalized).toBe(0);
  });
});

describe('normalizeAnswer / mismatch', () => {
  it('tipo de respuesta distinto al criterio lanza E_PROVIDER con hint', () => {
    try {
      normalizeAnswer(noul(), {
        type: 'choice',
        choice: 'yes',
        probabilities: { yes: 1, no: 0 },
        confidence: 1,
      });
      throw new Error('debió lanzar');
    } catch (e) {
      expect(e).toBeInstanceOf(M1Error);
      const err = e as M1Error;
      expect(err.code).toBe('E_PROVIDER');
      expect(err.hint).toBeTruthy();
      expect(err.hint).toContain('q.noul');
    }
  });
});

describe('weightedScore', () => {
  it('pondera por weight e ignora los weight 0', () => {
    const results = [
      res({ id: 'a', normalized: 1, weight: 3 }),
      res({ id: 'b', normalized: 0, weight: 1 }),
      res({ id: 'c', normalized: 0, weight: 0 }),
    ];
    expect(weightedScore(results)).toBe(75);
  });

  it('devuelve 0 si todos los pesos son 0', () => {
    expect(weightedScore([res({ id: 'a', normalized: 1, weight: 0 })])).toBe(0);
  });

  it('devuelve 0 con lista vacía', () => {
    expect(weightedScore([])).toBe(0);
  });

  it('redondea al entero más cercano', () => {
    const results = [
      res({ id: 'a', normalized: 1, weight: 1 }),
      res({ id: 'b', normalized: 1, weight: 1 }),
      res({ id: 'c', normalized: 0, weight: 1 }),
    ];
    expect(weightedScore(results)).toBe(67);
  });
});

describe('buildIssues', () => {
  it('ordena por severidad y luego por id, e incluye remediation', () => {
    const results = [
      res({ id: 'z', normalized: 0.2, passed: false, severity: 'minor', remediation: 'arreglar z' }),
      res({ id: 'b', normalized: 0.1, passed: false, severity: 'blocker' }),
      res({ id: 'a', normalized: 0.1, passed: false, severity: 'blocker', remediation: 'arreglar a' }),
      res({ id: 'ok', normalized: 1, passed: true, severity: 'blocker' }),
    ];
    const issues = buildIssues(results);
    expect(issues.map((i) => i.criterion)).toEqual(['a', 'b', 'z']);
    expect(issues[0]?.remediation).toBe('arreglar a');
    expect(issues[1]?.remediation).toBeUndefined();
    expect(SEVERITY_ORDER).toEqual(['blocker', 'major', 'minor', 'info']);
  });

  it('arma el mensaje estable con nombre, raw, normalizado y umbral', () => {
    const r = withPassAt(
      res({
        id: 'q1',
        name: 'Contraste',
        type: 'score',
        raw: 1,
        normalized: 0.33,
        passed: false,
        severity: 'major',
      }),
      0.5,
    );
    const [issue] = buildIssues([r]);
    expect(issue?.message).toBe('Contraste: score 1 (normalizado 0.33 < 0.50)');
  });
});

describe('evaluateAcceptance', () => {
  it('marca passed cuando la expresión es truthy', () => {
    const out = evaluateAcceptance(
      [{ id: 'acc1', expr: 'score >= 70', severity: 'blocker' }],
      { score: 80 },
    );
    expect(out).toEqual([{ id: 'acc1', expr: 'score >= 70', passed: true, severity: 'blocker' }]);
  });

  it('marca !passed cuando la expresión es falsy', () => {
    const out = evaluateAcceptance(
      [{ id: 'acc1', expr: 'score >= 70', severity: 'major' }],
      { score: 60 },
    );
    expect(out[0]?.passed).toBe(false);
  });

  it('propaga el error con el id del acceptance en el hint', () => {
    expect(() =>
      evaluateAcceptance([{ id: 'acc-rota', expr: 'score >>> 1', severity: 'major' }], { score: 1 }),
    ).toThrowError(M1Error);

    try {
      evaluateAcceptance([{ id: 'acc-rota', expr: 'score >>> 1', severity: 'major' }], { score: 1 });
    } catch (e) {
      const err = e as M1Error;
      expect(err.code).toBe('E_EXPR');
      expect(err.hint).toContain('acc-rota');
    }
  });
});

describe('decideVerdict', () => {
  const accept = (passed: boolean, severity: AcceptanceResult['severity'] = 'major'): AcceptanceResult => ({
    id: 'acc',
    expr: 'x > 0',
    passed,
    severity,
  });

  it('falla si un acceptance blocker falló', () => {
    expect(decideVerdict([], [accept(false, 'blocker')])).toBe('fail');
  });

  it('falla si un acceptance no-blocker falló', () => {
    expect(decideVerdict([], [accept(false, 'minor')])).toBe('fail');
  });

  it('needs_review si un blocker tiene baja confianza', () => {
    const results = [res({ id: 'b', severity: 'blocker', confidence: 0.4 })];
    expect(decideVerdict(results, [accept(true, 'blocker')])).toBe('needs_review');
  });

  it('respeta minConfidence custom', () => {
    const results = [res({ id: 'b', severity: 'blocker', confidence: 0.55 })];
    expect(decideVerdict(results, [], 0.5)).toBe('pass');
    expect(decideVerdict(results, [], 0.6)).toBe('needs_review');
  });

  it('falla sin acceptance y con blocker fallado', () => {
    const results = [res({ id: 'b', severity: 'blocker', passed: false, normalized: 0 })];
    expect(decideVerdict(results, [])).toBe('fail');
  });

  it('pasa cuando todo está ok', () => {
    const results = [
      res({ id: 'a', severity: 'blocker', passed: true, confidence: 0.9 }),
      res({ id: 'b', severity: 'major', passed: false }),
    ];
    expect(decideVerdict(results, [accept(true, 'blocker')])).toBe('pass');
  });
});
