import { collectRefs } from '../core/expr';
import type { AcceptanceResult, CriterionResult, RunResult } from '../schema/result';

/**
 * Salida mínima para agentes: sólo lo que hace falta para decidir el próximo paso.
 *
 * Deja afuera todo lo que es diagnóstico (probabilities, legend, confidence,
 * pesos, trace, tokens) y recorta los mensajes a lo accionable. Mismo veredicto
 * y mismas remediaciones que `--json`, con una fracción de los tokens.
 */

export interface AgentIssue {
  criterion: string;
  severity: string;
  message: string;
  remediation?: string;
}

export interface AgentGate {
  id: string;
  expr: string;
  severity: string;
  /** Valores actuales de los símbolos que usa la expresión. */
  detail?: string;
}

export interface AgentOutput {
  ok: true;
  runId: string;
  workflow: string;
  verdict: string;
  score: number;
  issues: AgentIssue[];
  gates: AgentGate[];
  derived: Record<string, number>;
  passed: string[];
  meta: {
    provider: string;
    model: string;
    calls: number;
    ms: number;
    truncated?: boolean;
    dryRun?: boolean;
  };
}

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function issueMessage(criterion: CriterionResult): string {
  const label = criterion.name ?? criterion.id;
  return `${label}: ${round(criterion.normalized)} < ${round(criterion.passAt)}`;
}

function gateDetail(gate: AcceptanceResult, scope: Record<string, number>): string | undefined {
  const parts: string[] = [];
  for (const ref of collectRefs(gate.expr)) {
    const value = scope[ref];
    if (value !== undefined) parts.push(`${ref} = ${round(value)}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

export function buildAgentOutput(result: RunResult): AgentOutput {
  const byId = new Map(result.criteria.map((criterion) => [criterion.id, criterion]));
  const scope: Record<string, number> = {};
  for (const criterion of result.criteria) scope[criterion.id] = criterion.normalized;
  for (const [id, value] of Object.entries(result.derived)) scope[id] = value;

  const issues: AgentIssue[] = [];
  for (const issue of result.issues) {
    const criterion = byId.get(issue.criterion);
    const item: AgentIssue = {
      criterion: issue.criterion,
      severity: issue.severity,
      message: criterion ? issueMessage(criterion) : issue.message,
    };
    if (issue.remediation !== undefined) item.remediation = issue.remediation;
    issues.push(item);
  }

  const gates: AgentGate[] = [];
  for (const gate of result.acceptance) {
    if (gate.passed) continue;
    const item: AgentGate = { id: gate.id, expr: gate.expr, severity: gate.severity };
    const detail = gateDetail(gate, scope);
    if (detail !== undefined) item.detail = detail;
    gates.push(item);
  }

  const derived: Record<string, number> = {};
  for (const [id, value] of Object.entries(result.derived)) derived[id] = round(value);

  const output: AgentOutput = {
    ok: true,
    runId: result.runId,
    workflow: result.agent.id,
    verdict: result.verdict,
    score: result.score,
    issues,
    gates,
    derived,
    passed: result.criteria
      .filter((criterion) => criterion.passed && criterion.weight > 0)
      .map((criterion) => criterion.id),
    meta: {
      provider: result.meta.provider,
      model: result.meta.model,
      calls: result.meta.calls,
      ms: result.meta.durationMs,
    },
  };
  if (result.meta.truncated) output.meta.truncated = true;
  if (result.meta.dryRun) output.meta.dryRun = true;

  return output;
}

/** Una sola línea de JSON: lo más barato de parsear para otro LLM. */
export function renderAgent(result: RunResult): string {
  return JSON.stringify(buildAgentOutput(result));
}