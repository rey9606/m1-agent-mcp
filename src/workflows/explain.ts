import type {
  Acceptance,
  Criterion,
  Derived,
  Limits,
  ResolvedRecipe,
  Severity,
  Slot,
} from '../schema/recipe';

/**
 * Vista explicada de un workflow: la misma información del JSON, pero
 * resuelta y en el orden en que el motor la usa (entrada -> etapas ->
 * criterios -> cálculo -> veredicto).
 *
 * El objetivo es que alguien que nunca vio el workflow entienda qué le va a
 * preguntar al modelo, cuándo salta una etapa y por qué un resultado pasa o no.
 */

export interface ExplainSlot {
  name: string;
  type: Slot['type'];
  required: boolean;
  max?: number;
  description?: string;
}

export interface ExplainOption {
  value: string;
  label: string;
  /** Valor normalizado 0..1; `null` si un `choice` no declara `mapping`. */
  normalized: number | null;
}

export interface ExplainCriterion {
  id: string;
  name?: string;
  type: Criterion['type'];
  instructions: string;
  weight: number;
  passAt: number;
  severity: Severity;
  polarity: Criterion['polarity'];
  options: ExplainOption[];
  remediation?: string;
  /** Sólo `score` positivo: primer nivel que alcanza el umbral. */
  passesFrom?: ExplainOption;
}

export interface ExplainStage {
  id: string;
  when: string | null;
  /** La etapa define su propio `state` (si no, hereda el del workflow). */
  ownState: boolean;
  /** `null` = hereda `input.images`. */
  images: string[] | null;
  questions: string[];
}

export interface ExplainedWorkflow {
  name: string;
  id: string;
  builtin: boolean;
  path: string;
  role: string;
  description?: string;
  whenToUse?: string;
  provider?: string;
  slots: ExplainSlot[];
  images: string[];
  stages: ExplainStage[];
  criteria: ExplainCriterion[];
  derived: Derived[];
  acceptance: Acceptance[];
  outputs: string[];
  limits: Limits;
  minConfidence: number;
  verdictRules: string[];
  scoreFormula: string;
  example: { command: string; notes: string[] };
}

const SCORE_FORMULA =
  'round(Σ(normalizado × peso) / Σ(peso) × 100), sólo criterios con peso > 0';

/** Dos decimales sin ceros de relleno (0.66, 1, 0.3). */
function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function optionsOf(criterion: Criterion): ExplainOption[] {
  const negative = criterion.polarity === 'negative';
  const flip = (value: number): number => (negative ? clamp01(1 - value) : clamp01(value));

  if (criterion.type === 'score' && Array.isArray(criterion.criteria)) {
    const levels = criterion.criteria.map(String);
    return levels.map((label, index) => ({
      value: String(index),
      label,
      normalized: flip(levels.length > 1 ? index / (levels.length - 1) : 0),
    }));
  }

  if (criterion.type === 'choice' && isRecord(criterion.criteria)) {
    const mapped = criterion.mapping;
    return Object.entries(criterion.criteria).map(([value, label]) => {
      const base = mapped?.[value];
      return {
        value,
        label: String(label),
        normalized: base === undefined ? null : flip(base),
      };
    });
  }

  if (criterion.type === 'noul' && isRecord(criterion.criteria)) {
    const legend = criterion.criteria as { true?: unknown; false?: unknown };
    return [
      { value: 'sí', label: legend.true === undefined ? '' : String(legend.true), normalized: flip(1) },
      { value: 'no', label: legend.false === undefined ? '' : String(legend.false), normalized: flip(0) },
    ];
  }

  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function explainCriterion(criterion: Criterion): ExplainCriterion {
  const options = optionsOf(criterion);
  const explained: ExplainCriterion = {
    id: criterion.id,
    type: criterion.type,
    instructions: criterion.instructions,
    weight: criterion.weight,
    passAt: criterion.passAt,
    severity: criterion.severity,
    polarity: criterion.polarity,
    options,
  };
  if (criterion.name !== undefined) explained.name = criterion.name;
  if (criterion.remediation !== undefined) explained.remediation = criterion.remediation;

  if (criterion.type === 'score' && criterion.polarity === 'positive') {
    const passing = options.find((option) => (option.normalized ?? 0) >= criterion.passAt);
    if (passing) explained.passesFrom = passing;
  }

  return explained;
}

/**
 * Mismo criterio que usa `run` para elegir el slot de `--state`:
 * un único slot, o un único `text`, o un único `text` requerido, o `state`.
 */
function pickTextSlot(slots: ExplainSlot[]): string | undefined {
  if (slots.length === 1) return slots[0]!.name;
  const textSlots = slots.filter((slot) => slot.type === 'text');
  if (textSlots.length === 1) return textSlots[0]!.name;
  const required = textSlots.filter((slot) => slot.required);
  if (required.length === 1) return required[0]!.name;
  return slots.some((slot) => slot.name === 'state') ? 'state' : undefined;
}

function buildExample(name: string, slots: ExplainSlot[]): { command: string; notes: string[] } {
  const parts = ['m1 run', name];
  const notes: string[] = [];

  const imageSlots = slots.filter((slot) => slot.type === 'image' || slot.type === 'image[]');
  const imageSlot = imageSlots[0];
  if (imageSlot) {
    parts.push('--image ./pantalla.png');
    if (imageSlots.length > 1) parts.push(`--image-slot ${imageSlot.name}`);
  }

  const textSlot = pickTextSlot(slots);
  if (textSlot) {
    parts.push(`--slot ${textSlot} "..."`);
  } else if (slots.length > 0) {
    parts.push('--input datos.json');
  }

  parts.push('--json');

  if (imageSlot) {
    const max = imageSlot.max ?? 1;
    notes.push(
      max > 1
        ? `--image es repetible: podés pasar hasta ${max} imágenes`
        : 'con imágenes y un provider local subí el timeout: --timeout 300000',
    );
    if (max > 1) notes.push('con imágenes y un provider local subí el timeout: --timeout 300000');
  }

  return { command: parts.join(' '), notes };
}

export interface ExplainSource {
  recipe: ResolvedRecipe;
  name: string;
  builtin: boolean;
  path: string;
  description?: string;
}

export function explainWorkflow(source: ExplainSource): ExplainedWorkflow {
  const { recipe } = source;
  const slots: ExplainSlot[] = Object.entries(recipe.input.slots).map(([name, slot]) => {
    const explained: ExplainSlot = { name, type: slot.type, required: slot.required };
    if (slot.max !== undefined) explained.max = slot.max;
    if (slot.description !== undefined) explained.description = slot.description;
    return explained;
  });

  const minConfidence = recipe.limits.minConfidence ?? 0.6;
  const verdictRules = [
    'acceptance blocker o major incumplido → fail',
    'criterio blocker incumplido → fail',
    'acceptance minor o info incumplido → needs_review',
    `criterio blocker con confianza < ${fmt(minConfidence)} → needs_review`,
    'si nada de eso → pass',
  ];

  const explained: ExplainedWorkflow = {
    name: source.name,
    id: recipe.id,
    builtin: source.builtin,
    path: source.path,
    role: recipe.role,
    slots,
    images: [...recipe.input.images],
    stages: recipe.stages.map((stage) => {
      const item: ExplainStage = {
        id: stage.id,
        when: stage.when ?? null,
        ownState: stage.state !== undefined,
        images: stage.images === undefined ? null : [...stage.images],
        questions: [...stage.questions],
      };
      return item;
    }),
    criteria: recipe.criteria.map(explainCriterion),
    derived: recipe.derived.map((item) => ({ ...item })),
    acceptance: recipe.acceptance.map((item) => ({ ...item })),
    outputs: [...recipe.outputs],
    limits: { ...recipe.limits },
    minConfidence,
    verdictRules,
    scoreFormula: SCORE_FORMULA,
    example: buildExample(source.name, slots),
  };

  if (source.description !== undefined) explained.description = source.description;
  if (recipe.whenToUse !== undefined) explained.whenToUse = recipe.whenToUse;
  if (recipe.provider !== undefined) explained.provider = recipe.provider;

  return explained;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

export function renderExplainText(workflow: ExplainedWorkflow): string {
  const lines: string[] = [];
  const push = (line = ''): void => {
    lines.push(line);
  };

  push(`  ${workflow.name} · ${workflow.builtin ? 'built-in' : 'usuario'}`);
  if (workflow.description) push(`  ${workflow.description}`);
  push();
  push(`  rol       ${workflow.role}`);
  if (workflow.whenToUse) push(`  cuándo    ${workflow.whenToUse}`);
  if (workflow.provider) push(`  provider  ${workflow.provider} (fijo para este workflow)`);
  push(`  archivo   ${workflow.path}`);
  push();

  push('  QUÉ RECIBE');
  if (workflow.slots.length === 0) {
    push('    (no declara slots: el state se arma con variables primitivas)');
  }
  const nameWidth = Math.max(0, ...workflow.slots.map((slot) => slot.name.length));
  const typeWidth = Math.max(0, ...workflow.slots.map((slot) => slot.type.length));
  for (const slot of workflow.slots) {
    let line = `    ${pad(slot.name, nameWidth)}  ${pad(slot.type, typeWidth)}  ${slot.required ? 'requerido' : 'opcional '}`;
    if (slot.description) line += `  ${slot.description}`;
    if (slot.max !== undefined) line += ` · máx. ${slot.max}`;
    push(line);
  }
  push();
  push('    ejemplo');
  push(`      ${workflow.example.command}`);
  for (const note of workflow.example.notes) push(`      nota: ${note}`);
  push();

  push(`  ETAPAS (${workflow.stages.length})`);
  const stageWidth = Math.max(0, ...workflow.stages.map((stage) => stage.id.length));
  const byId = new Map(workflow.criteria.map((criterion) => [criterion.id, criterion]));
  workflow.stages.forEach((stage, index) => {
    const count = stage.questions.length;
    const condition = stage.when ? `sólo si: ${stage.when}` : 'siempre';
    const extras = stage.ownState ? ' · state propio' : '';
    push(
      `    ${index + 1}  ${pad(stage.id, stageWidth)}  ${count} ${count === 1 ? 'pregunta' : 'preguntas'} · ${condition}${extras}`,
    );
    for (const questionId of stage.questions) {
      const criterion = byId.get(questionId);
      const label = criterion?.name ?? '(criterio inexistente)';
      const type = criterion?.type ?? '?';
      push(`       ${questionId}  ${label} (${type})`);
    }
  });
  push();

  push(`  CRITERIOS (${workflow.criteria.length})`);
  const idWidth = Math.max(0, ...workflow.criteria.map((criterion) => criterion.id.length));
  const indent = `    ${' '.repeat(idWidth)}  `;
  for (const criterion of workflow.criteria) {
    const weight =
      criterion.weight === 0 ? 'peso 0 (informativo, no suma al score)' : `peso ${fmt(criterion.weight)}`;
    push(
      `    ${pad(criterion.id, idWidth)}  ${criterion.name ?? criterion.id}  ·  ${criterion.type}  ·  ${weight}  ·  severidad ${criterion.severity}`,
    );
    push(`${indent}${criterion.instructions}`);

    if (criterion.type === 'noul') {
      for (const option of criterion.options) {
        const value = option.normalized === null ? '?' : fmt(option.normalized);
        push(`${indent}${option.value} → ${value}${option.label ? `  ${option.label}` : ''}`);
      }
    } else if (criterion.options.length > 0) {
      const label = criterion.type === 'score' ? 'niveles ' : 'opciones ';
      const rendered = criterion.options
        .map((option) => {
          const value = option.normalized === null ? 'prob.' : fmt(option.normalized);
          return `${option.value} ${option.label} → ${value}`;
        })
        .join(' · ');
      push(`${indent}${label}${rendered}`);
    }

    if (criterion.passesFrom) {
      const label = criterion.passesFrom.label.split(':')[0] ?? criterion.passesFrom.label;
      push(
        `${indent}aprueba  ≥ ${fmt(criterion.passAt)} (desde el nivel ${criterion.passesFrom.value}: ${label})`,
      );
    } else {
      push(`${indent}aprueba  ≥ ${fmt(criterion.passAt)}`);
    }
    if (criterion.polarity === 'negative') {
      push(`${indent}polaridad negative: el valor se invierte (1 - x)`);
    }
    if (criterion.remediation) {
      push(`${indent}si falla: ${criterion.remediation}`);
    }
    push();
  }

  push('  CÓMO SE CALCULA');
  push(`    score    ${workflow.scoreFormula}`);
  const derivedWidth = Math.max(0, ...workflow.derived.map((item) => item.id.length));
  for (const item of workflow.derived) {
    const description = item.description ? `   (${item.description})` : '';
    push(`    ${pad(item.id, derivedWidth)} ${item.expr}${description}`);
  }
  push();

  push('  QUÉ HACE FALTA PARA PASAR');
  if (workflow.acceptance.length === 0) {
    push('    (sin acceptance: el veredicto depende sólo de los criterios)');
  } else {
    const acceptanceWidth = Math.max(0, ...workflow.acceptance.map((item) => item.id.length));
    const exprWidth = Math.max(0, ...workflow.acceptance.map((item) => item.expr.length));
    for (const item of workflow.acceptance) {
      const outcome = item.severity === 'blocker' || item.severity === 'major' ? 'fail' : 'needs_review';
      push(
        `    ${pad(item.id, acceptanceWidth)}  ${pad(item.expr, exprWidth)}  ${pad(item.severity, 7)}  · si falla → ${outcome}`,
      );
    }
  }
  push();
  push('    reglas del veredicto (las aplica el motor, no el modelo):');
  for (const rule of workflow.verdictRules) push(`      · ${rule}`);
  push();

  const limitBits = [`minConfidence ${fmt(workflow.minConfidence)}`];
  if (workflow.limits.maxStages !== undefined) limitBits.unshift(`maxStages ${workflow.limits.maxStages}`);
  if (workflow.limits.timeoutMs !== undefined) limitBits.push(`timeoutMs ${workflow.limits.timeoutMs}`);
  push(`  SALIDA    ${workflow.outputs.join(', ')}`);
  push(`  LÍMITES   ${limitBits.join(' · ')}`);
  push();
  push(`  JSON crudo: m1 workflow show ${workflow.name}  ·  schema: m1 workflow schema`);

  return `${lines.join('\n')}\n`;
}

/** Escapa un texto para una etiqueta de Mermaid entre comillas. */
function mermaidText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, "'");
}

export function renderExplainMermaid(workflow: ExplainedWorkflow): string {
  const lines: string[] = ['flowchart TD'];

  const input =
    workflow.slots.length === 0
      ? 'sin slots'
      : workflow.slots
          .map((slot) => `${slot.name}: ${slot.type}${slot.required ? ' (requerido)' : ''}`)
          .map(mermaidText)
          .join('<br/>');
  lines.push(`  IN["entrada<br/>${input}"]`);

  workflow.stages.forEach((stage, index) => {
    const questions = stage.questions.map(mermaidText).join(' · ');
    lines.push(`  S${index + 1}["${mermaidText(stage.id)}<br/>${questions}"]`);
  });

  const derived = workflow.derived.map((item) => item.id).map(mermaidText).join(' · ');
  lines.push(`  AGG["agregación<br/>score 0..100${derived ? `<br/>${derived}` : ''}"]`);
  lines.push('  V(["pass · fail · needs_review"])');

  let previous = 'IN';
  workflow.stages.forEach((stage, index) => {
    const node = `S${index + 1}`;
    const label = stage.when ? mermaidText(stage.when) : 'siempre';
    lines.push(`  ${previous} -->|"${label}"| ${node}`);
    if (stage.when) {
      const fallback = index + 1 < workflow.stages.length ? `S${index + 2}` : 'AGG';
      lines.push(`  ${previous} -->|"si no"| ${fallback}`);
    }
    previous = node;
  });
  lines.push(`  ${previous} --> AGG`);

  if (workflow.acceptance.length > 0) {
    const ids = workflow.acceptance.map((item) => item.id).map(mermaidText).join(' · ');
    lines.push(`  AGG --> ACC{"acceptance<br/>${ids}"}`);
    lines.push('  ACC -->|"cumple"| V');
    lines.push('  ACC -->|"no cumple"| V');
  } else {
    lines.push('  AGG --> V');
  }

  lines.push('  classDef input fill:#eef2ff,stroke:#6366f1,color:#1e1b4b');
  lines.push('  classDef stage fill:#f5f3ff,stroke:#8b5cf6,color:#2e1065');
  lines.push('  classDef decision fill:#fef3c7,stroke:#d97706,color:#78350f');
  lines.push('  classDef verdict fill:#dcfce7,stroke:#16a34a,color:#14532d');
  lines.push('  class IN input');
  lines.push(`  class ${workflow.stages.map((_, index) => `S${index + 1}`).join(',')} stage`);
  lines.push('  class AGG stage');
  if (workflow.acceptance.length > 0) lines.push('  class ACC decision');
  lines.push('  class V verdict');

  return `${lines.join('\n')}\n`;
}