export type ErrorCode =
  | 'E_USAGE'
  | 'E_VALIDATION'
  | 'E_INPUT'
  | 'E_CONFIG'
  | 'E_PROVIDER'
  | 'E_TIMEOUT'
  | 'E_EXPR'
  | 'E_INTERNAL';

/**
 * Error único del sistema. `hint` es lo que lee el agente/LLM que invoca la CLI:
 * debe ser accionable, no decorativo.
 */
export class M1Error extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = 'M1Error';
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, details: this.details };
  }
}

export function isM1Error(e: unknown): e is M1Error {
  return e instanceof M1Error;
}
