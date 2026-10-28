import type { RunResult } from '../schema/result';

/**
 * Redondea números para la salida. Los floats del modelo llegan con 17
 * decimales (0.45704162260834924) y eso no aporta nada al consumidor:
 * sólo ocupa tokens y ensucia la lectura.
 */
function roundDeep(value: unknown, digits: number): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
  if (Array.isArray(value)) return value.map((item) => roundDeep(item, digits));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = roundDeep(item, digits);
    }
    return out;
  }
  return value;
}

export function renderJson(result: RunResult): string {
  return JSON.stringify(roundDeep(result, 3), null, 2);
}