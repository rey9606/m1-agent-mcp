import type { Acceptance, Severity } from '../schema/recipe';
import type { AcceptanceResult, CriterionResult, Issue, Verdict } from '../schema/result';
import { M1Error, isM1Error } from './errors';
import { evaluateExpression } from './expr';

/** Orden de severidad de mayor a menor gravedad. */
export const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor', 'info'];

function severityRank(severity: Severity): number {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx === -1 ? SEVERITY_ORDER.length : idx;
}

/**
 * Score ponderado 0..100 (entero). Sólo suman los criterios con `weight > 0`.
 * Si la suma de pesos es 0, devuelve 0.
 */
export function weightedScore(results: CriterionResult[]): number {
  let weighted = 0;
  let total = 0;
  for (const r of results) {
    if (!(r.weight > 0)) continue;
    weighted += r.normalized * r.weight;
    total += r.weight;
  }
  if (total === 0) return 0;
  return Math.round((weighted / total) * 100);
}

/** `passAt` vive en el resultado; fallback defensivo para resultados externos. */
function passAtOf(result: CriterionResult): number {
  return typeof result.passAt === 'number' ? result.passAt : 0.5;
}

function formatRaw(result: CriterionResult): string {
  if (result.type === 'score') {
    return `score ${typeof result.raw === 'number' ? Number(result.raw.toFixed(2)) : result.raw}`;
  }
  return typeof result.raw === 'number' ? String(Number(result.raw.toFixed(2))) : String(result.raw);
}

/** Issues de los criterios que no pasaron, ordenados por severidad y luego por id. */
export function buildIssues(results: CriterionResult[]): Issue[] {
  const issues: Issue[] = [];
  for (const r of results) {
    if (r.passed) continue;
    const passAt = passAtOf(r);
    const issue: Issue = {
      criterion: r.id,
      severity: r.severity,
      message: `${r.name ?? r.id}: ${formatRaw(r)} (normalizado ${r.normalized.toFixed(2)} < ${passAt.toFixed(2)})`,
    };
    if (r.remediation !== undefined) issue.remediation = r.remediation;
    issues.push(issue);
  }
  issues.sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    if (a.criterion < b.criterion) return -1;
    if (a.criterion > b.criterion) return 1;
    return 0;
  });
  return issues;
}

/**
 * Evalúa las expresiones de aceptación sobre el scope.
 * Un resultado truthy => passed. Un error de sintaxis/ref se propaga como M1Error
 * con el id del acceptance en el hint.
 */
export function evaluateAcceptance(
  defs: Acceptance[],
  scope: Record<string, number | string | boolean>,
): AcceptanceResult[] {
  return defs.map((def) => {
    let passed: boolean;
    try {
      passed = Boolean(evaluateExpression(def.expr, scope));
    } catch (e) {
      const detail = isM1Error(e) ? (e.hint ?? e.message) : e instanceof Error ? e.message : String(e);
      throw new M1Error(
        isM1Error(e) ? e.code : 'E_EXPR',
        `Falló el acceptance "${def.id}": ${isM1Error(e) ? e.message : String(e)}`,
        {
          hint: `Revisá la expresión del acceptance "${def.id}" (${JSON.stringify(def.expr)}). Causa: ${detail}`,
          details: { acceptance: def.id, expr: def.expr },
          cause: e,
        },
      );
    }
    return { id: def.id, expr: def.expr, passed, severity: def.severity };
  });
}

/**
 * Veredicto determinista.
 *
 * 1. acceptance `blocker` o `major` fallado → fail (gate duro)
 * 2. criterio `blocker` fallado → fail
 * 3. acceptance `minor` o `info` fallado → needs_review (aviso, no gate)
 * 4. criterio `blocker` con confianza < minConfidence → needs_review
 * 5. pass
 */
export function decideVerdict(
  results: CriterionResult[],
  acceptance: AcceptanceResult[],
  minConfidence = 0.6,
): Verdict {
  if (acceptance.some((a) => !a.passed && (a.severity === 'blocker' || a.severity === 'major'))) {
    return 'fail';
  }
  if (results.some((r) => r.severity === 'blocker' && !r.passed)) return 'fail';
  if (acceptance.some((a) => !a.passed)) return 'needs_review';
  if (
    results.some(
      (r) =>
        r.severity === 'blocker' &&
        r.confidence !== undefined &&
        r.confidence < minConfidence,
    )
  ) {
    return 'needs_review';
  }
  return 'pass';
}
