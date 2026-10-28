import type { Answer } from '../providers/types';
import type { Criterion } from '../schema/recipe';
import { M1Error } from './errors';

export interface NormalizedAnswer {
  raw: number | string;
  /** 0..1, con polarity ya aplicada. */
  normalized: number;
  /** Umbral efectivo (`criterion.passAt`, default 0.5). */
  passAt: number;
  /** `normalized >= passAt`. */
  passed: boolean;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, unknown>;
}

/** Clampea un número al rango [0, 1]. `NaN` se considera 0. */
export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normaliza la respuesta del modelo para un criterio.
 *
 * - `noul`: usa `noul` como probabilidad.
 * - `choice`: usa `mapping[choice]` o, si falta, `probabilities[choice]`.
 * - `score`: divide el score por (niveles - 1) para llevarlo a 0..1.
 *
 * La polaridad `negative` invierte el valor normalizado (1 - x).
 */
export function normalizeAnswer(criterion: Criterion, answer: Answer): NormalizedAnswer {
  if (answer.type !== criterion.type) {
    throw new M1Error(
      'E_PROVIDER',
      `Tipo de respuesta incompatible para "${criterion.id}": se esperaba "${criterion.type}" pero llegó "${answer.type}"`,
      {
        hint: `El provider respondió con el tipo equivocado. Verificá que la pregunta "${criterion.id}" se envíe como type="${criterion.type}" y que el modelo devuelva el mismo tipo.`,
        details: { criterion: criterion.id, expected: criterion.type, received: answer.type },
      },
    );
  }

  const polarity = criterion.polarity ?? 'positive';
  const passAt = criterion.passAt ?? 0.5;

  let raw: number | string;
  let normalized: number;
  let confidence: number | undefined;
  let probabilities: Record<string, number> | undefined;
  let legend: Record<string, unknown> | undefined;

  // `answer.type === criterion.type` ya está garantizado arriba; el switch
  // estrecha la unión de `Answer` para TypeScript.
  switch (answer.type) {
    case 'noul': {
      raw = clamp01(answer.noul);
      normalized = polarity === 'negative' ? 1 - raw : raw;
      break;
    }
    case 'choice': {
      const choice = answer.choice;
      const base = criterion.mapping?.[choice] ?? answer.probabilities[choice] ?? 0;
      raw = choice;
      normalized = polarity === 'negative' ? 1 - base : base;
      confidence = answer.confidence;
      probabilities = answer.probabilities;
      break;
    }
    case 'score': {
      const levels = Array.isArray(criterion.criteria) ? criterion.criteria.length : 0;
      raw = answer.score;
      normalized = levels > 1 ? clamp01(answer.score / (levels - 1)) : 0;
      if (polarity === 'negative') normalized = 1 - normalized;
      confidence = answer.confidence;
      probabilities = answer.probabilities;
      legend = answer.legend;
      break;
    }
  }

  const result: NormalizedAnswer = {
    raw,
    normalized,
    passAt,
    passed: normalized >= passAt,
  };
  if (confidence !== undefined) result.confidence = confidence;
  if (probabilities !== undefined) result.probabilities = probabilities;
  if (legend !== undefined) result.legend = legend;
  return result;
}
