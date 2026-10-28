import type { Criterion, ResolvedRecipe, Stage } from '../schema/recipe';
import { M1Error } from './errors';

export interface PlannedStage {
  stage: Stage;
  questions: Criterion[];
}

/**
 * Mapea cada etapa declarada a sus criterios, en el orden declarado.
 * No evalúa `when`: eso es responsabilidad del motor en tiempo de ejecución.
 */
export function planStages(recipe: ResolvedRecipe): PlannedStage[] {
  const byId = new Map(recipe.criteria.map((c) => [c.id, c]));

  return recipe.stages.map((stage) => ({
    stage,
    questions: stage.questions.map((id) => {
      const criterion = byId.get(id);
      if (!criterion) {
        throw new M1Error('E_VALIDATION', `la etapa "${stage.id}" pregunta un criterio inexistente: "${id}"`, {
          hint: 'validá el workflow con `m1 workflow validate` antes de planificar',
        });
      }
      return criterion;
    }),
  }));
}
