import type { RunResult } from '../schema/result';

const ICON: Record<string, string> = { pass: '✓ PASS', fail: '✗ FAIL', needs_review: '? REVIEW' };

function bar(normalized: number): string {
  const filled = Math.round(normalized * 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

/** Salida para humanos. Sin ANSI: la CLI decide si colorea. */
export function renderHuman(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`${ICON[result.verdict] ?? result.verdict}  ${result.agent.id} (${result.agent.role})`);
  lines.push(`score: ${result.score}/100   calls: ${result.meta.calls}   ${result.meta.durationMs}ms   ${result.meta.provider}/${result.meta.model}`);
  lines.push('');
  for (const c of result.criteria) {
    const mark = c.passed ? '✓' : '✗';
    const raw = typeof c.raw === 'number' ? c.raw.toFixed(2) : c.raw;
    lines.push(`  ${mark} ${c.id.padEnd(10)} ${bar(c.normalized)} ${(c.normalized * 100).toFixed(0).padStart(3)}%  ${c.name ?? ''} (raw ${raw})`);
  }
  if (Object.keys(result.derived).length > 0) {
    lines.push('');
    lines.push(`  derivados: ${Object.entries(result.derived).map(([k, v]) => `${k}=${v.toFixed(2)}`).join('  ')}`);
  }
  if (result.issues.length > 0) {
    lines.push('');
    lines.push('  issues:');
    for (const i of result.issues) {
      lines.push(`   [${i.severity}] ${i.criterion}: ${i.message}`);
      if (i.remediation) lines.push(`            → ${i.remediation}`);
    }
  }
  if (result.trace?.some((t) => t.status !== 'ran')) {
    lines.push('');
    lines.push('  etapas:');
    for (const t of result.trace) {
      lines.push(`   - ${t.id}: ${t.status}${t.reason ? ` (${t.reason})` : ''}`);
    }
  }
  return lines.join('\n');
}
