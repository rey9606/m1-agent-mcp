import type { RunResult } from '../schema/result';

export function renderJson(result: RunResult): string {
  return JSON.stringify(result, null, 2);
}
