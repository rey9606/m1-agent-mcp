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
  /** Sólo mock: directorio de fixtures. */
  fixturesDir?: string;
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
