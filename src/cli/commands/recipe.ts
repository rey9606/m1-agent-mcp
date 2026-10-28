import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { M1Error } from '../../core/errors';
import { validateRecipe } from '../../core/validate';
import { recipeSchema } from '../../schema/recipe';
import { fail } from '../output';

export async function recipeValidateCommand(path: string, flags: { json?: boolean }): Promise<never> {
  try {
    const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch {
      throw new M1Error('E_INPUT', `no se pudo leer la receta: ${abs}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new M1Error('E_VALIDATION', 'la receta no es JSON válido', { hint: 'revisá comas y comillas', cause: e });
    }
    const { recipe, warnings } = validateRecipe(raw, { filePath: abs, defaultId: basename(abs).replace(/\.json$/i, '') });
    const payload = {
      ok: true,
      id: recipe.id,
      role: recipe.role,
      criteria: recipe.criteria.length,
      stages: recipe.stages.map((s) => ({ id: s.id, questions: s.questions.length })),
      warnings,
    };
    if (flags.json) process.stdout.write(JSON.stringify(payload) + '\n');
    else {
      process.stdout.write(`  ✓ receta válida: ${recipe.id} (${recipe.role})\n`);
      process.stdout.write(`    criterios: ${recipe.criteria.length} · etapas: ${recipe.stages.length}\n`);
      for (const w of warnings) process.stdout.write(`    ! ${w}\n`);
    }
    process.exit(0);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}

export function recipeSchemaCommand(_flags: { json?: boolean }): never {
  // Zod 4 genera JSON Schema nativo; se envuelve en `definitions.Recipe` para
  // conservar el contrato estable que ya consumen los tests y usuarios.
  const definition = z.toJSONSchema(recipeSchema, { target: 'draft-7' });
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $ref: '#/definitions/Recipe',
    definitions: { Recipe: definition },
  };
  process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
  process.exit(0);
}

export { z };
