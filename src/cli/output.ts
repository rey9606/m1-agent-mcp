import { M1Error } from '../core/errors';

export interface JsonError {
  ok: false;
  error: { code: string; message: string; hint?: string; details?: unknown };
}

export function errorPayload(e: unknown): JsonError {
  if (e instanceof M1Error) {
    return { ok: false, error: { code: e.code, message: e.message, hint: e.hint, details: e.details } };
  }
  const err = e as Error | undefined;
  return {
    ok: false,
    error: {
      code: 'E_INTERNAL',
      message: err?.message ?? String(e),
      hint: 'esto es un bug: reportá el comando y el input',
    },
  };
}

/** Imprime el error y corta con exit 2 (error de uso/config/proveedor). */
export function fail(e: unknown, json: boolean): never {
  const payload = errorPayload(e);
  if (json) {
    process.stderr.write(JSON.stringify(payload) + '\n');
  } else {
    process.stderr.write(`\n  ✗ ${payload.error.code}: ${payload.error.message}\n`);
    if (payload.error.hint) process.stderr.write(`    → ${payload.error.hint}\n`);
    if (payload.error.details !== undefined) {
      const details = JSON.stringify(payload.error.details, null, 2);
      process.stderr.write(`    ${details}\n`);
    }
    process.stderr.write('\n');
  }
  process.exit(2);
}

export const EXIT = {
  pass: 0,
  fail: 1,
  error: 2,
  needs_review: 3,
} as const;

export function isTty(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}
