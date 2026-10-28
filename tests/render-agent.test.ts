import { describe, expect, it } from 'vitest';

import { buildAgentOutput, renderAgent } from '../src/render/agent.js';
import { renderJson } from '../src/render/json.js';
import type { RunResult } from '../src/schema/result.js';

const RESULT: RunResult = {
  runId: 'run_test',
  agent: { id: 'copy-checker', role: 'Editor de copy' },
  verdict: 'fail',
  score: 60,
  criteria: [
    {
      id: 'CP-1',
      name: 'Claridad',
      type: 'score',
      stage: 'base',
      raw: 1.9395724854507281,
      normalized: 0.6465241618169094,
      passAt: 0.66,
      passed: false,
      confidence: 0.48660698570377403,
      probabilities: { '0': 0.09303501133833879, '1': 0.10084024174607124 },
      legend: { '0': 'Confuso', '1': 'Mejorable' },
      weight: 0.3,
      severity: 'major',
      remediation: 'Una idea por oración.',
    },
    {
      id: 'CP-3',
      name: 'Llamado a la acción',
      type: 'noul',
      stage: 'base',
      raw: 0.8966172025819378,
      normalized: 0.8966172025819378,
      passAt: 0.7,
      passed: true,
      weight: 0.2,
      severity: 'blocker',
    },
    {
      id: 'CP-6',
      name: 'Desvío de tono',
      type: 'choice',
      stage: 'diagnostico',
      raw: 'vendedor',
      normalized: 0.2,
      passAt: 0.3,
      passed: false,
      weight: 0,
      severity: 'info',
      remediation: 'Reescribí el pasaje más desviado.',
    },
  ],
  derived: { quality: 0.5997979693756273 },
  acceptance: [
    { id: 'A1', expr: 'CP-3 >= 0.7', passed: true, severity: 'blocker' },
    { id: 'A3', expr: 'quality >= 0.7', passed: false, severity: 'major' },
  ],
  issues: [
    {
      criterion: 'CP-1',
      severity: 'major',
      message: 'Claridad: score 1.9395724854507281 (normalizado 0.65 < 0.66)',
      remediation: 'Una idea por oración.',
    },
    {
      criterion: 'CP-6',
      severity: 'info',
      message: 'Desvío de tono: vendedor (normalizado 0.20 < 0.30)',
      remediation: 'Reescribí el pasaje más desviado.',
    },
  ],
  meta: {
    provider: 'liquid',
    model: 'd1-omni-600M',
    calls: 2,
    inputTokens: 2680,
    outputTokens: 0,
    durationMs: 15970,
    truncated: false,
  },
};

describe('renderAgent', () => {
  const output = buildAgentOutput(RESULT);

  it('deja sólo lo accionable y redondea', () => {
    expect(output.verdict).toBe('fail');
    expect(output.workflow).toBe('copy-checker');
    expect(output.derived).toEqual({ quality: 0.6 });
    expect(output.issues[0]).toEqual({
      criterion: 'CP-1',
      severity: 'major',
      message: 'Claridad: 0.65 < 0.66',
      remediation: 'Una idea por oración.',
    });
  });

  it('no emite probabilities, legend, confidence ni trace', () => {
    const text = renderAgent(RESULT);

    expect(text).not.toContain('probabilities');
    expect(text).not.toContain('legend');
    expect(text).not.toContain('confidence');
    expect(text).not.toContain('trace');
  });

  it('lista los gates que fallaron con los valores actuales', () => {
    expect(output.gates).toEqual([
      { id: 'A3', expr: 'quality >= 0.7', severity: 'major', detail: 'quality = 0.6' },
    ]);
  });

  it('resume los criterios aprobados con peso (los informativos no cuentan)', () => {
    expect(output.passed).toEqual(['CP-3']);
  });

  it('es un único objeto JSON parseable', () => {
    const parsed = JSON.parse(renderAgent(RESULT)) as { ok: boolean; meta: { calls: number } };

    expect(parsed.ok).toBe(true);
    expect(parsed.meta.calls).toBe(2);
    expect(renderAgent(RESULT)).not.toContain('\n');
  });

  it('cuesta una fracción de la salida completa', () => {
    expect(renderAgent(RESULT).length).toBeLessThan(renderJson(RESULT).length / 2);
  });
});

describe('renderJson', () => {
  it('redondea los floats a 3 decimales', () => {
    const parsed = JSON.parse(renderJson(RESULT)) as {
      criteria: Array<{ normalized: number; probabilities?: Record<string, number> }>;
    };

    expect(parsed.criteria[0]?.normalized).toBe(0.647);
    expect(parsed.criteria[0]?.probabilities?.['0']).toBe(0.093);
  });
});