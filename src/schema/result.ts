import type { QuestionType, Severity } from './recipe';

export type Verdict = 'pass' | 'fail' | 'needs_review';

export interface CriterionResult {
  id: string;
  name?: string;
  type: QuestionType;
  stage: string;
  /** Valor crudo devuelto por el modelo (probabilidad, label o score). */
  raw: number | string;
  /** Valor normalizado 0..1 (polarity ya aplicada). */
  normalized: number;
  /** Umbral usado para `passed` (default 0.5). */
  passAt: number;
  passed: boolean;
  confidence?: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, unknown>;
  weight: number;
  severity: Severity;
  remediation?: string;
}

export interface Issue {
  criterion: string;
  severity: Severity;
  message: string;
  remediation?: string;
}

export interface AcceptanceResult {
  id: string;
  expr: string;
  passed: boolean;
  severity: Severity;
}

export interface StageTrace {
  id: string;
  status: 'ran' | 'skipped' | 'error';
  reason?: string;
  questions: string[];
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export interface RunMeta {
  provider: string;
  model: string;
  calls: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  truncated: boolean;
  dryRun?: boolean;
}

export interface RunResult {
  runId: string;
  agent: { id: string; role: string };
  verdict: Verdict;
  score: number;
  criteria: CriterionResult[];
  derived: Record<string, number>;
  acceptance: AcceptanceResult[];
  issues: Issue[];
  meta: RunMeta;
  trace?: StageTrace[];
}
