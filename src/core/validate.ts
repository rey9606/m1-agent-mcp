import path from 'node:path';
import { recipeSchema, type ResolvedRecipe } from '../schema/recipe';
import { M1Error } from './errors';
import { collectRefs } from './expr';

export interface RecipeValidation {
  recipe: ResolvedRecipe;
  warnings: string[];
}

interface ValidationIssue {
  path: string;
  message: string;
}

const HINT = 'corregí los campos listados; `m1 recipe schema` imprime el JSON Schema';

const LITERALS = new Set(['true', 'false', 'null', 'undefined']);

function refExists(ref: string, known: Set<string>): boolean {
  if (known.has(ref)) return true;
  // `UX-1.normalized`, `UX-1.choice`, `derived.normalized`, etc.
  for (const id of known) {
    if (ref.startsWith(`${id}.`)) return true;
  }
  return false;
}

/**
 * Valida una receta cruda (parse + chequeos semánticos que zod no puede ver).
 * Junta TODOS los problemas antes de fallar, para que el agente los corrija de una.
 */
export function validateRecipe(
  raw: unknown,
  opts: { defaultId?: string; filePath?: string } = {},
): RecipeValidation {
  const parsed = recipeSchema.safeParse(raw);
  if (!parsed.success) {
    const details: ValidationIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(root)',
      message: issue.message,
    }));
    throw new M1Error('E_VALIDATION', `receta inválida: ${details.length} problema(s) de esquema`, {
      details,
      hint: HINT,
    });
  }

  const recipe = parsed.data;
  const errors: ValidationIssue[] = [];
  const warnings: string[] = [];

  // --- id resuelto -------------------------------------------------------
  const fallbackId = opts.filePath
    ? path.basename(opts.filePath, path.extname(opts.filePath))
    : undefined;
  const id = recipe.id ?? opts.defaultId ?? fallbackId;
  if (!id) {
    errors.push({
      path: 'id',
      message: 'falta el id de la receta (no hay id, defaultId ni filePath del cual derivarlo)',
    });
  }

  // --- criterios ---------------------------------------------------------
  const criterionById = new Map<string, (typeof recipe.criteria)[number]>();
  recipe.criteria.forEach((c, i) => {
    if (criterionById.has(c.id)) {
      errors.push({ path: `criteria.${i}.id`, message: `id de criterio duplicado: "${c.id}"` });
    } else {
      criterionById.set(c.id, c);
    }
  });
  const criterionIds = new Set(recipe.criteria.map((c) => c.id));

  // --- ids de derived / acceptance ---------------------------------------
  const derivedIds = new Set<string>();
  recipe.derived.forEach((d, i) => {
    if (derivedIds.has(d.id)) {
      errors.push({ path: `derived.${i}.id`, message: `id de derived duplicado: "${d.id}"` });
    }
    if (criterionIds.has(d.id)) {
      errors.push({ path: `derived.${i}.id`, message: `derived "${d.id}" colisiona con un id de criterio` });
    }
    derivedIds.add(d.id);
  });

  const acceptanceIds = new Set<string>();
  recipe.acceptance.forEach((a, i) => {
    if (acceptanceIds.has(a.id)) {
      errors.push({ path: `acceptance.${i}.id`, message: `id de acceptance duplicado: "${a.id}"` });
    }
    if (criterionIds.has(a.id)) {
      errors.push({ path: `acceptance.${i}.id`, message: `acceptance "${a.id}" colisiona con un id de criterio` });
    }
    acceptanceIds.add(a.id);
  });

  // --- etapas ------------------------------------------------------------
  const maxStages = recipe.limits.maxStages ?? 32;
  if (recipe.stages.length > maxStages) {
    errors.push({
      path: 'stages',
      message: `la receta declara ${recipe.stages.length} etapas y el límite es ${maxStages} (limits.maxStages)`,
    });
  }

  const asked = new Set<string>();
  recipe.stages.forEach((stage, i) => {
    stage.questions.forEach((q) => {
      if (!criterionById.has(q)) {
        errors.push({
          path: `stages.${i}.questions`,
          message: `la etapa "${stage.id}" pregunta un criterio inexistente: "${q}"`,
        });
      } else {
        asked.add(q);
      }
    });

    if (stage.when !== undefined) {
      try {
        for (const ref of collectRefs(stage.when)) {
          if (LITERALS.has(ref)) continue;
          if (!refExists(ref, criterionIds) && !refExists(ref, derivedIds)) {
            errors.push({
              path: `stages.${i}.when`,
              message: `la condición de la etapa "${stage.id}" referencia un valor inexistente: "${ref}"`,
            });
          }
        }
      } catch (e) {
        errors.push({
          path: `stages.${i}.when`,
          message: `la condición de la etapa "${stage.id}" no parsea: ${(e as Error).message}`,
        });
      }
    }
  });

  for (const c of recipe.criteria) {
    if (!asked.has(c.id)) {
      warnings.push(`criterio "${c.id}" no se pregunta nunca`);
    }
  }

  // --- imágenes ----------------------------------------------------------
  recipe.input.images.forEach((slot, i) => {
    const def = recipe.input.slots[slot];
    if (!def) {
      errors.push({
        path: `input.images.${i}`,
        message: `el slot de imagen "${slot}" no existe en input.slots`,
      });
    } else if (def.type !== 'image' && def.type !== 'image[]') {
      errors.push({
        path: `input.images.${i}`,
        message: `el slot "${slot}" es de tipo "${def.type}" y no puede enviarse como imagen`,
      });
    }
  });
  recipe.stages.forEach((stage, i) => {
    stage.images?.forEach((slot) => {
      const def = recipe.input.slots[slot];
      if (!def) {
        errors.push({
          path: `stages.${i}.images`,
          message: `la etapa "${stage.id}" referencia un slot de imagen inexistente: "${slot}"`,
        });
      } else if (def.type !== 'image' && def.type !== 'image[]') {
        errors.push({
          path: `stages.${i}.images`,
          message: `la etapa "${stage.id}" referencia el slot "${slot}" que no es de tipo imagen`,
        });
      }
    });
  });

  // --- expresiones -------------------------------------------------------
  const knownForAcceptance = new Set([...criterionIds, ...derivedIds]);

  recipe.derived.forEach((d, i) => {
    try {
      for (const ref of collectRefs(d.expr)) {
        if (LITERALS.has(ref)) continue;
        if (!refExists(ref, knownForAcceptance)) {
          errors.push({
            path: `derived.${i}.expr`,
            message: `derived "${d.id}" referencia un valor inexistente: "${ref}"`,
          });
        }
      }
    } catch (e) {
      errors.push({
        path: `derived.${i}.expr`,
        message: `derived "${d.id}" no parsea: ${(e as Error).message}`,
      });
    }
  });

  recipe.acceptance.forEach((a, i) => {
    try {
      for (const ref of collectRefs(a.expr)) {
        if (LITERALS.has(ref)) continue;
        if (!refExists(ref, knownForAcceptance)) {
          errors.push({
            path: `acceptance.${i}.expr`,
            message: `acceptance "${a.id}" referencia un valor inexistente: "${ref}"`,
          });
        }
      }
    } catch (e) {
      errors.push({
        path: `acceptance.${i}.expr`,
        message: `acceptance "${a.id}" no parsea: ${(e as Error).message}`,
      });
    }
  });

  if (errors.length > 0) {
    throw new M1Error('E_VALIDATION', `receta inválida: ${errors.length} problema(s) semántico(s)`, {
      details: errors,
      hint: HINT,
    });
  }

  return { recipe: { ...recipe, id: id as string }, warnings };
}
