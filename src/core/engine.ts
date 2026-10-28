import { randomUUID } from 'node:crypto';

import type { DecisionProvider, DecisionRequest, DecisionResponse, ImageInput, Question } from '../providers/types';
import type { Criterion, Recipe, ResolvedRecipe } from '../schema/recipe';
import type { CriterionResult, RunResult, StageTrace } from '../schema/result';
import { resolveInput } from '../intake/input';
import { assertBodyBudget, assertImageBudget, type LoadedImage } from '../intake/images';
import { buildIssues, decideVerdict, evaluateAcceptance, weightedScore } from './aggregate';
import { M1Error, isM1Error } from './errors';
import { evaluateExpression, type ExprScope } from './expr';
import { normalizeAnswer } from './normalize';
import { planStages } from './plan';
import { renderTemplate } from './template';

export interface EngineEvent {
  type: 'stage:start' | 'stage:end' | 'stage:skip' | 'stage:error' | 'run:end';
  stage?: string;
  detail?: unknown;
}

export interface EngineDeps {
  provider: DecisionProvider;
  providerName: string;
  model: string;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: (e: EngineEvent) => void;
  /** Override para tests; si no, usa resolveInput. */
  resolveInput?: (raw: unknown, recipe: Recipe) => Promise<{ vars: Record<string, unknown>; imagesBySlot: Record<string, LoadedImage[]> }>;
}

type Primitive = number | string | boolean;

function isPrimitive(value: unknown): value is Primitive {
  return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
}

function primitiveVars(vars: Record<string, unknown>): Record<string, Primitive> {
  const flat: Record<string, Primitive> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (isPrimitive(value)) flat[key] = value;
  }
  return flat;
}

function toNumberResult(value: number | string | boolean): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildQuestion(criterion: Criterion): Question {
  if (criterion.type === 'choice') {
    return {
      type: 'choice',
      instructions: criterion.instructions,
      criteria: criterion.criteria as Record<string, unknown>,
    };
  }
  if (criterion.type === 'score') {
    return {
      type: 'score',
      instructions: criterion.instructions,
      criteria: criterion.criteria as unknown[],
    };
  }
  const question: Question = { type: 'noul', instructions: criterion.instructions };
  if (criterion.criteria !== undefined) {
    question.criteria = criterion.criteria as { true?: unknown; false?: unknown };
  }
  return question;
}

function stageProviderError(error: unknown, stageId: string): M1Error {
  if (isM1Error(error) && (error.code === 'E_CONFIG' || error.code === 'E_PROVIDER' || error.code === 'E_INPUT' || error.code === 'E_TIMEOUT')) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new M1Error('E_PROVIDER', `etapa "${stageId}" falló: ${message}`, {
    hint: `la llamada al provider falló en la etapa "${stageId}"; revisá credenciales, red y el modelo configurado`,
    details: isM1Error(error) ? error.toJSON() : { message },
    cause: error,
  });
}

function stageExprError(error: unknown, stageId: string, kind: 'when' | 'state'): M1Error {
  const message = error instanceof Error ? error.message : String(error);
  const what = kind === 'when' ? '"when"' : '"state"';
  return new M1Error('E_EXPR', `la etapa "${stageId}" tiene un ${what} inválido: ${message}`, {
    hint:
      kind === 'when'
        ? `revisá la expresión "when" de la etapa "${stageId}"; las referencias deben existir en criterios o derived`
        : `revisá las referencias {{...}} del state de la etapa "${stageId}"`,
    details: { stage: stageId, kind },
    cause: error,
  });
}

/**
 * Ejecuta una receta validada: resuelve input, recorre etapas, normaliza
 * respuestas y agrega el resultado final.
 */
export async function runRecipe(args: {
  recipe: ResolvedRecipe;
  input: unknown;
  deps: EngineDeps;
  options?: { dryRun?: boolean; timeoutMs?: number };
}): Promise<RunResult> {
  const { recipe, input, deps, options } = args;
  const startedAt = Date.now();
  const dryRun = options?.dryRun === true;
  const timeoutMs = options?.timeoutMs ?? deps.timeoutMs ?? recipe.limits.timeoutMs ?? 60_000;

  const emit = (event: EngineEvent) => {
    deps.onEvent?.(event);
  };

  const resolved = await (deps.resolveInput
    ? deps.resolveInput(input, recipe)
    : resolveInput(input, recipe, { cwd: deps.cwd }));

  const vars = resolved.vars;
  const imagesBySlot = resolved.imagesBySlot;

  /** Scope plano para expresiones: `UX-1`, `UX-1.normalized`, `UX-1.choice`, ... */
  const exprScope: ExprScope = { ...primitiveVars(vars) };
  /** Scope rico para plantillas. */
  const richAnswers: Record<string, unknown> = {};

  const criteriaResults: CriterionResult[] = [];
  const trace: StageTrace[] = [];
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  // En dry-run no hay respuestas reales: sembramos valores neutros para que
  // `when` y las plantillas `{{answers.*}}` puedan renderizarse.
  if (dryRun) {
    for (const criterion of recipe.criteria) {
      const firstChoice =
        criterion.type === 'choice' && typeof criterion.criteria === 'object' && criterion.criteria !== null
          ? Object.keys(criterion.criteria as Record<string, unknown>)[0]
          : undefined;
      exprScope[criterion.id] = 0.5;
      exprScope[`${criterion.id}.normalized`] = 0.5;
      exprScope[`${criterion.id}.confidence`] = 0.5;
      if (firstChoice !== undefined) exprScope[`${criterion.id}.choice`] = firstChoice;
      richAnswers[criterion.id] = {
        type: criterion.type,
        ...(firstChoice !== undefined ? { choice: firstChoice } : {}),
        raw: firstChoice ?? 0.5,
        normalized: 0.5,
        passed: false,
        confidence: 0.5,
      };
    }
  }

  const planned = planStages(recipe);

  for (const { stage, questions } of planned) {
    emit({ type: 'stage:start', stage: stage.id });

    // 1. `when` (en dry-run no hay respuestas previas: se ejecutan todas las etapas)
    if (stage.when !== undefined && !dryRun) {
      let condition: number | string | boolean;
      try {
        condition = evaluateExpression(stage.when, exprScope);
      } catch (error) {
        const err = stageExprError(error, stage.id, 'when');
        trace.push({ id: stage.id, status: 'error', questions: [...stage.questions], error: err.message });
        emit({ type: 'stage:error', stage: stage.id, detail: err.toJSON() });
        throw err;
      }
      if (!condition) {
        trace.push({ id: stage.id, status: 'skipped', reason: 'when=false', questions: [...stage.questions] });
        emit({ type: 'stage:skip', stage: stage.id, detail: { reason: 'when=false' } });
        continue;
      }
    }

    // 2. state
    const richVars: Record<string, unknown> = { ...vars, answers: richAnswers, criteria: exprScope };
    const stateTemplate = stage.state ?? recipe.input.state ?? primitiveVars(vars);
    let state: unknown;
    try {
      state = renderTemplate(stateTemplate, richVars);
    } catch (error) {
      const err = stageExprError(error, stage.id, 'state');
      trace.push({ id: stage.id, status: 'error', questions: [...stage.questions], error: err.message });
      emit({ type: 'stage:error', stage: stage.id, detail: err.toJSON() });
      throw err;
    }

    // 3. images
    const slots = stage.images ?? recipe.input.images;
    const loadedImages: LoadedImage[] = [];
    for (const slot of slots) {
      for (const image of imagesBySlot[slot] ?? []) loadedImages.push(image);
    }
    const images: ImageInput[] = loadedImages.map((image) => ({
      content_type: image.content_type,
      base64: image.base64,
    }));

    // 4. questions
    const questionMap: Record<string, Question> = {};
    for (const criterion of questions) questionMap[criterion.id] = buildQuestion(criterion);

    const request: DecisionRequest = { model: deps.model, state, questions: questionMap };
    if (images.length > 0) request.images = images;

    // 5. dry run: no se llama al provider.
    if (dryRun) {
      if (loadedImages.length > 0) assertImageBudget(loadedImages);
      trace.push({ id: stage.id, status: 'ran', questions: [...stage.questions], durationMs: 0 });
      emit({ type: 'stage:end', stage: stage.id, detail: { dryRun: true, request } });
      continue;
    }

    // 6. llamada al provider
    if (loadedImages.length > 0) {
      try {
        assertImageBudget(loadedImages);
      } catch (error) {
        trace.push({ id: stage.id, status: 'error', questions: [...stage.questions], error: (error as Error).message });
        emit({ type: 'stage:error', stage: stage.id, detail: error });
        throw error;
      }
    }

    const callStarted = Date.now();
    let response: DecisionResponse;
    try {
      // Guarda de tamaño real del body (no sólo de las imágenes): el límite es 13 MiB.
      assertBodyBudget(Buffer.byteLength(JSON.stringify(request), 'utf8'));
      response = await deps.provider.evaluate(request, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const err = stageProviderError(error, stage.id);
      trace.push({
        id: stage.id,
        status: 'error',
        questions: [...stage.questions],
        durationMs: Date.now() - callStarted,
        error: err.message,
      });
      emit({ type: 'stage:error', stage: stage.id, detail: err.toJSON() });
      throw err;
    }
    calls += 1;

    // 7. normalización
    try {
      for (const criterion of questions) {
        const answer = response.answers?.[criterion.id];
        if (!answer) {
          throw new M1Error('E_PROVIDER', `faltó la respuesta para "${criterion.id}" en la etapa "${stage.id}"`, {
            hint: `el provider no devolvió "${criterion.id}"; verificá que el modelo responda todas las preguntas de la etapa`,
            details: { stage: stage.id, criterion: criterion.id },
          });
        }
        const normalizedAnswer = normalizeAnswer(criterion, answer);
        criteriaResults.push({
          id: criterion.id,
          ...(criterion.name !== undefined ? { name: criterion.name } : {}),
          type: criterion.type,
          stage: stage.id,
          raw: normalizedAnswer.raw,
          normalized: normalizedAnswer.normalized,
          passed: normalizedAnswer.passed,
          ...(normalizedAnswer.confidence !== undefined ? { confidence: normalizedAnswer.confidence } : {}),
          ...(normalizedAnswer.probabilities !== undefined ? { probabilities: normalizedAnswer.probabilities } : {}),
          ...(normalizedAnswer.legend !== undefined ? { legend: normalizedAnswer.legend } : {}),
          weight: criterion.weight,
          severity: criterion.severity,
          ...(criterion.remediation !== undefined ? { remediation: criterion.remediation } : {}),
        });

        const id = criterion.id;
        exprScope[id] = normalizedAnswer.normalized;
        exprScope[`${id}.normalized`] = normalizedAnswer.normalized;
        if (criterion.type === 'choice') {
          exprScope[`${id}.choice`] = String(normalizedAnswer.raw);
        }
        if (normalizedAnswer.confidence !== undefined) {
          exprScope[`${id}.confidence`] = normalizedAnswer.confidence;
        }

        richAnswers[id] = {
          ...answer,
          raw: normalizedAnswer.raw,
          normalized: normalizedAnswer.normalized,
          passed: normalizedAnswer.passed,
        };
      }
    } catch (error) {
      const err = stageProviderError(error, stage.id);
      trace.push({
        id: stage.id,
        status: 'error',
        questions: [...stage.questions],
        durationMs: Date.now() - callStarted,
        error: err.message,
      });
      emit({ type: 'stage:error', stage: stage.id, detail: err.toJSON() });
      throw err;
    }

    const usage = response.usage ?? {};
    const stageInput = usage.input_tokens ?? 0;
    const stageOutput = usage.output_tokens ?? 0;
    inputTokens += stageInput;
    outputTokens += stageOutput;

    const durationMs = Date.now() - callStarted;
    trace.push({
      id: stage.id,
      status: 'ran',
      questions: [...stage.questions],
      durationMs,
      ...(usage.input_tokens !== undefined ? { inputTokens: stageInput } : {}),
      ...(usage.output_tokens !== undefined ? { outputTokens: stageOutput } : {}),
    });
    emit({
      type: 'stage:end',
      stage: stage.id,
      detail: { durationMs, inputTokens: stageInput, outputTokens: stageOutput },
    });
  }

  // 8. derived
  const derived: Record<string, number> = {};
  if (!dryRun) {
    for (const def of recipe.derived) {
      let value: number | string | boolean;
      try {
        value = evaluateExpression(def.expr, exprScope);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new M1Error('E_EXPR', `falló el derived "${def.id}": ${message}`, {
          hint: `revisá la expresión del derived "${def.id}" (${JSON.stringify(def.expr)})`,
          details: { derived: def.id, expr: def.expr },
          cause: error,
        });
      }
      const num = toNumberResult(value);
      derived[def.id] = num;
      exprScope[def.id] = num;
      exprScope[`${def.id}.normalized`] = num;
    }
  }

  // 9. acceptance + veredicto + score + issues
  const acceptanceResults = dryRun ? [] : evaluateAcceptance(recipe.acceptance, exprScope);
  const verdict = dryRun ? 'fail' : decideVerdict(criteriaResults, acceptanceResults, recipe.limits.minConfidence);
  const score = dryRun ? 0 : weightedScore(criteriaResults);
  const issues = dryRun ? [] : buildIssues(criteriaResults);

  const result: RunResult = {
    runId: `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    agent: { id: recipe.id, role: recipe.role },
    verdict,
    score,
    criteria: criteriaResults,
    derived,
    acceptance: acceptanceResults,
    issues,
    meta: {
      provider: deps.providerName,
      model: deps.model,
      calls,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
      truncated: false,
      dryRun,
    },
    trace,
  };

  emit({ type: 'run:end', detail: { verdict, score, calls } });

  return result;
}
