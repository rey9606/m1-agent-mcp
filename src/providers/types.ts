/** Contrato del proveedor de decisiones. Es el mismo para Clef, JEV y endpoints compatibles. */

export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true?: unknown; false?: unknown };
};

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, unknown>;
};

export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: unknown[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface ImageInput {
  content_type: string;
  base64: string;
}

export interface DecisionRequest {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
  images?: ImageInput[];
}

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: 'score';
  score: number;
  legend?: Record<string, unknown>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  raw?: unknown;
}

export type ProviderKind = 'cloudflare' | 'typesafe' | 'openrouter' | 'systemone' | 'mock';

/** Formato del campo `images` en el body. `object` = {content_type, base64}. */
export type ImageFormat = 'object' | 'dataUrl';

/** Política para levantar un servidor local cuando no responde. */
export type LocalAutoStart = 'ask' | 'always' | 'never';

/**
 * Cómo levantar el servidor local (p. ej. `llama-server`).
 * Sólo aplica a providers `kind: systemone` con `baseUrl` loopback.
 */
export interface LocalLaunchConfig {
  /** Ejecutable. Default: `llama-server`. */
  command?: string;
  /** Argumentos. Admite `{port}`, `{host}`, `{model}` y `{baseUrl}`. */
  args?: string[];
  /** Puerto preferido. Default: el puerto de `baseUrl`. */
  port?: number;
  /** Ruta de health relativa al origin. Default: `/health`. */
  healthPath?: string;
  /** Espera máxima a que el servidor quede listo. Default: 180000. */
  startTimeoutMs?: number;
  /** `ask` pregunta en TTY; `always` arranca sin preguntar; `never` no arranca. */
  autoStart?: LocalAutoStart;
}

export interface ProviderConfig {
  kind: ProviderKind;
  model?: string;
  baseUrl?: string;
  accountId?: string;
  /** Nombre de la env var con la key. Preferido sobre `apiKey`. */
  apiKeyEnv?: string;
  /** Key literal (sólo config local, nunca en la receta). */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Cómo desenvolver la respuesta HTTP. `auto` detecta `{result:{...}}`. */
  unwrap?: 'auto' | 'result' | 'none';
  timeoutMs?: number;
  /** Formato de `images` para endpoints `systemone`. Default: `object`. */
  imageFormat?: ImageFormat;
  /** Sólo mock: directorio de fixtures. */
  fixturesDir?: string;
  /** Sólo systemone local: cómo levantar el servidor si no está corriendo. */
  launch?: LocalLaunchConfig;
}

export interface DecideOptions {
  signal?: AbortSignal;
}

export interface DecisionProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  /** Capacidades conocidas; `undefined` = desconocido (no bloquear). */
  readonly capabilities?: { images: boolean };
  evaluate(request: DecisionRequest, options?: DecideOptions): Promise<DecisionResponse>;
}
