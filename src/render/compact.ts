import type { RunResult } from '../schema/result';

const ICON: Record<string, string> = { pass: 'PASS', fail: 'FAIL', needs_review: 'REVIEW' };

/** Una línea, pensada para que otro LLM la lea barato. */
export function renderCompact(result: RunResult): string {
  const failed = result.criteria.filter((c) => !c.passed).map((c) => c.id);
  return [
    `[${ICON[result.verdict] ?? result.verdict}] ${result.agent.id} score=${result.score}`,
    failed.length ? `fallan=${failed.join(',')}` : 'sin fallas',
    `issues=${result.issues.length} calls=${result.meta.calls} ${result.meta.durationMs}ms`,
  ].join(' · ');
}
