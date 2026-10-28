import { z } from 'zod';

/**
 * Receta de agente: la unidad declarativa del sistema.
 * Todo lo que el motor necesita para ejecutar vive acá (salvo credenciales).
 */

export const RECIPE_SCHEMA_ID = 'm1agent/recipe@1';

/** Valores permitidos en plantillas de state: strings con `{{slot}}`. */
export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | TemplateValue[]
  | { [key: string]: TemplateValue };

export const templateValueSchema: z.ZodType<TemplateValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(templateValueSchema),
    z.record(z.string(), templateValueSchema),
  ]),
);

export const questionTypeSchema = z.enum(['noul', 'choice', 'score']);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const severitySchema = z.enum(['blocker', 'major', 'minor', 'info']);
export type Severity = z.infer<typeof severitySchema>;

export const slotTypeSchema = z.enum(['text', 'json', 'image', 'image[]']);
export type SlotType = z.infer<typeof slotTypeSchema>;

export const slotSchema = z.object({
  type: slotTypeSchema,
  required: z.boolean().default(false),
  description: z.string().optional(),
  /** Tope de elementos para `image[]`. Default: 4 (límite duro de la API). */
  max: z.number().int().positive().max(4).optional(),
});
export type Slot = z.infer<typeof slotSchema>;

export const criterionSchema = z
  .object({
    /** Id de la pregunta en el request y clave de la respuesta. `[A-Za-z0-9_.-]{1,100}`. */
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'id inválido: usá letras, dígitos, "_", "." o "-" (máx 100)'),
    name: z.string().optional(),
    type: questionTypeSchema,
    instructions: z.string().min(1, 'instructions no puede estar vacío'),
    /**
     * Para `choice`: mapa id → descripción (2..255).
     * Para `score`: array ordenado de niveles, menor primero (2..10).
     * Para `noul`: opcional `{ true?: desc, false?: desc }`.
     */
    criteria: z.unknown().optional(),
    /** `negative` invierte la normalización (ej: "¿tiene un problema de contraste?"). */
    polarity: z.enum(['positive', 'negative']).default('positive'),
    /** Umbral de aprobación sobre el valor normalizado 0..1. */
    passAt: z.number().min(0).max(1).default(0.5),
    /** Peso en el score final. 0 = informativo, no suma. */
    weight: z.number().min(0).default(1),
    severity: severitySchema.default('major'),
    /** Texto accionable estático. Es lo que devuelve el agente cuando el criterio falla. */
    remediation: z.string().optional(),
    /** Sólo `choice`: valor 0..1 de cada opción. Si falta, se usa `probabilities[choice]`. */
    mapping: z.record(z.string(), z.number().min(0).max(1)).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.type === 'score') {
      if (!Array.isArray(c.criteria)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'score requiere un array de niveles' });
      } else if (c.criteria.length < 2 || c.criteria.length > 10) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'score requiere entre 2 y 10 niveles' });
      }
    }
    if (c.type === 'choice') {
      if (typeof c.criteria !== 'object' || c.criteria === null || Array.isArray(c.criteria)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'choice requiere un objeto id → descripción' });
      } else {
        const n = Object.keys(c.criteria).length;
        if (n < 2 || n > 255) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: `choice requiere entre 2 y 255 opciones (hay ${n})` });
        }
      }
      if (c.mapping) {
        const opts = new Set(Object.keys(c.criteria as Record<string, unknown>));
        for (const key of Object.keys(c.mapping)) {
          if (!opts.has(key)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mapping', key], message: `mapping referencia una opción inexistente: "${key}"` });
          }
        }
      }
    }
    if (c.type === 'noul' && c.criteria !== undefined) {
      if (typeof c.criteria !== 'object' || c.criteria === null || Array.isArray(c.criteria)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria'], message: 'noul admite { true?, false? } o nada' });
      }
    }
  });
export type Criterion = z.infer<typeof criterionSchema>;

export const stageSchema = z.object({
  id: z.string().min(1),
  /** Ids de criterios a preguntar en esta llamada (1..64). */
  questions: z.array(z.string()).min(1).max(64, 'máximo 64 preguntas por etapa (límite de la API)'),
  /** Expresión: si es falsa, la etapa se saltea. */
  when: z.string().optional(),
  /** Plantilla de state; si falta, se usa `recipe.input.state`. */
  state: templateValueSchema.optional(),
  /** Slots de imagen a enviar en esta etapa; si falta, se usan los de `recipe.input.images`. */
  images: z.array(z.string()).optional(),
});
export type Stage = z.infer<typeof stageSchema>;

export const acceptanceSchema = z.object({
  id: z.string().min(1),
  expr: z.string().min(1),
  severity: severitySchema.default('major'),
});
export type Acceptance = z.infer<typeof acceptanceSchema>;

export const derivedSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  expr: z.string().min(1),
  description: z.string().optional(),
});
export type Derived = z.infer<typeof derivedSchema>;

export const recipeInputSchema = z.object({
  slots: z.record(z.string(), slotSchema).default({}),
  /** Plantilla del state. Si se omite, el state es el objeto de variables. */
  state: templateValueSchema.optional(),
  /** Nombres de slots de imagen que se mandan en `images[]`. */
  images: z.array(z.string()).default([]),
});
export type RecipeInput = z.infer<typeof recipeInputSchema>;

export const limitsSchema = z.object({
  maxStages: z.number().int().positive().max(64).optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Si un criterio con `severity: blocker` tiene confianza menor, el veredicto pasa a needs_review. */
  minConfidence: z.number().min(0).max(1).optional(),
});
export type Limits = z.infer<typeof limitsSchema>;

export const recipeSchema = z.object({
  schema: z.literal(RECIPE_SCHEMA_ID).optional(),
  id: z.string().min(1).optional(),
  role: z.string().min(1, 'role es obligatorio'),
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  /** Alias del provider en la config. Si falta, se usa el default. */
  provider: z.string().optional(),
  input: recipeInputSchema.default({ slots: {}, images: [] }),
  criteria: z.array(criterionSchema).min(1),
  stages: z.array(stageSchema).min(1),
  derived: z.array(derivedSchema).default([]),
  acceptance: z.array(acceptanceSchema).default([]),
  outputs: z.array(z.string()).default(['verdict', 'score', 'criteria', 'issues']),
  limits: limitsSchema.default({}),
});
export type Recipe = z.infer<typeof recipeSchema>;

/** Receta ya resuelta: no incluye defaults pendientes. */
export type ResolvedRecipe = Recipe & { id: string };
