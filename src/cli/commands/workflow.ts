import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { M1Error } from '../../core/errors';
import { validateRecipe } from '../../core/validate';
import { z } from 'zod';
import { recipeSchema } from '../../schema/recipe';
import {
  createWorkflow,
  deleteWorkflow,
  editableWorkflowPath,
  exportWorkflow,
  findWorkflow,
  importWorkflow,
  listWorkflows,
  readWorkflowFile,
  resolveWorkflowPath,
  userWorkflowsDir,
} from '../../workflows/store';
import { workflowGuidePayload } from '../../workflows/guide';
import { explainWorkflow, renderExplainMermaid, renderExplainText } from '../../workflows/explain';
import { fail } from '../output';

export interface WorkflowListFlags {
  json?: boolean;
}

export interface WorkflowShowFlags {
  json?: boolean;
}

export interface WorkflowExplainFlags {
  json?: boolean;
  format?: string;
}

export interface WorkflowNewFlags {
  from?: string;
  role?: string;
  description?: string;
  json?: boolean;
}

export interface WorkflowImportFlags {
  name?: string;
  json?: boolean;
}

export interface WorkflowExportFlags {
  out?: string;
}

export interface WorkflowEditFlags {
  json?: boolean;
}

export interface WorkflowDeleteFlags {
  yes?: boolean;
  json?: boolean;
}

export interface WorkflowValidateFlags {
  json?: boolean;
}

export interface WorkflowGuideFlags {
  json?: boolean;
}

function printTable(rows: string[][], header: string[]): void {
  const table = [header, ...rows];
  const widths = header.map((_, index) => Math.max(...table.map((row) => (row[index] ?? '').length)));
  for (const row of table) {
    const line = row.map((cell, index) => (cell ?? '').padEnd(widths[index]!)).join('  ').trimEnd();
    process.stdout.write(`  ${line}\n`);
  }
}

export function workflowListCommand(flags: WorkflowListFlags): never {
  try {
    const warnings: string[] = [];
    const workflows = listWorkflows(warnings);
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          workflows: workflows.map((entry) => ({
            name: entry.name,
            description: entry.description,
            role: entry.role,
            builtin: entry.builtin,
            ...(entry.shadowed ? { shadowed: true } : {}),
            ...(entry.error ? { error: entry.error } : {}),
          })),
          warnings,
        }) + '\n',
      );
    } else {
      for (const warning of warnings) process.stderr.write(`  ! ${warning}\n`);
      if (workflows.length === 0) {
        process.stdout.write('  (no hay workflows)\n');
      } else {
        printTable(
          workflows.map((entry) => [
            entry.name,
            entry.builtin ? 'built-in' : 'usuario',
            entry.shadowed ? `(duplicado) ${entry.description}` : entry.description,
          ]),
          ['NOMBRE', 'TIPO', 'DESCRIPCIÓN'],
        );
      }
      process.stdout.write(`\n  usuario: ${userWorkflowsDir()}\n`);
      process.stdout.write('  creá uno con: m1 workflow new <nombre>\n');
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

export function workflowShowCommand(name: string, flags: WorkflowShowFlags): never {
  try {
    const entry = findWorkflow(name);
    if (entry.error) throw new M1Error('E_VALIDATION', entry.error);
    const workflow = readWorkflowFile(entry.path);
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          name: entry.name,
          builtin: entry.builtin,
          description: entry.description,
          role: entry.role,
          path: entry.path,
          workflow,
        }) + '\n',
      );
    } else {
      process.stdout.write(`  ${entry.name} (${entry.builtin ? 'built-in' : 'usuario'})\n`);
      process.stdout.write(`  ${entry.description}\n`);
      if (entry.role) process.stdout.write(`  rol: ${entry.role}\n`);
      process.stdout.write('\n');
      process.stdout.write(`${JSON.stringify(workflow, null, 2)}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

export function workflowExplainCommand(name: string, flags: WorkflowExplainFlags): never {
  try {
    const format = flags.format ?? 'text';
    if (format !== 'text' && format !== 'mermaid') {
      throw new M1Error('E_USAGE', `formato desconocido: ${format}`, {
        hint: 'usá --format text (default) o --format mermaid',
      });
    }

    const entry = findWorkflow(name);
    if (entry.error) throw new M1Error('E_VALIDATION', entry.error);
    const { recipe, warnings } = validateRecipe(readWorkflowFile(entry.path), {
      defaultId: entry.name,
      filePath: entry.path,
    });
    const explained = explainWorkflow({
      recipe,
      name: entry.name,
      builtin: entry.builtin,
      path: entry.path,
      description: entry.description,
    });

    if (flags.json) {
      const payload: Record<string, unknown> = { ok: true, ...explained, warnings };
      if (format === 'mermaid') payload.mermaid = renderExplainMermaid(explained);
      process.stdout.write(JSON.stringify(payload) + '\n');
    } else if (format === 'mermaid') {
      process.stdout.write(renderExplainMermaid(explained));
      for (const warning of warnings) process.stderr.write(`  ! ${warning}\n`);
    } else {
      process.stdout.write(renderExplainText(explained));
      for (const warning of warnings) process.stderr.write(`  ! ${warning}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

export function workflowNewCommand(name: string, flags: WorkflowNewFlags): never {
  try {
    const result = createWorkflow(name, {
      from: flags.from,
      role: flags.role,
      description: flags.description,
    });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    } else {
      process.stdout.write(`  ✓ workflow creado: ${result.name}\n`);
      process.stdout.write(`    archivo: ${result.path}\n`);
      process.stdout.write(`    siguiente: m1 workflow validate ${result.name}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

export function workflowImportCommand(file: string, flags: WorkflowImportFlags): never {
  try {
    const result = importWorkflow(file, { name: flags.name });
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, name: result.name, path: result.path, warnings: result.warnings }) + '\n',
      );
    } else {
      process.stdout.write(`  ✓ workflow importado: ${result.name}\n`);
      process.stdout.write(`    archivo: ${result.path}\n`);
      for (const warning of result.warnings) process.stdout.write(`    ! ${warning}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

export function workflowExportCommand(name: string, flags: WorkflowExportFlags): never {
  try {
    const result = exportWorkflow(name);
    if (flags.out) {
      writeFileSync(flags.out, result.text.endsWith('\n') ? result.text : `${result.text}\n`, 'utf8');
      process.stdout.write(`  ✓ ${result.name} exportado a ${flags.out}\n`);
    } else {
      process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, false);
  }
}

export function workflowEditCommand(name: string, flags: WorkflowEditFlags): never {
  try {
    const path = editableWorkflowPath(name);
    const editor = process.env.EDITOR?.trim() || process.env.VISUAL?.trim() || (process.platform === 'win32' ? 'notepad.exe' : 'vi');
    const result = spawnSync(`${editor} "${path}"`, { shell: true, stdio: 'inherit' });
    if (result.error) {
      throw new M1Error('E_INPUT', `no se pudo abrir el editor "${editor}"`, {
        hint: 'definí EDITOR o editá el archivo a mano',
        details: { path },
      });
    }

    const raw = readWorkflowFile(path);
    const { warnings } = validateRecipe(raw, { defaultId: basename(path).replace(/\.json$/iu, '') });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, name, path, warnings }) + '\n');
    } else {
      process.stdout.write(`  ✓ ${name} editado y validado\n`);
      for (const warning of warnings) process.stdout.write(`    ! ${warning}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^(y|yes|s|si|sí)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function workflowDeleteCommand(name: string, flags: WorkflowDeleteFlags): Promise<never> {
  try {
    if (!flags.yes) {
      const ok = await confirm(`¿Borrar el workflow "${name}"? [y/N] `);
      if (!ok) {
        throw new M1Error('E_USAGE', 'borrado cancelado', {
          hint: 'para automatizar usá --yes',
        });
      }
    }
    const path = deleteWorkflow(name);
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: true, name, deleted: true, path }) + '\n');
    } else {
      process.stdout.write(`  ✓ workflow borrado: ${name}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

export function workflowValidateCommand(ref: string, flags: WorkflowValidateFlags): never {
  try {
    const path = resolveWorkflowPath(ref);
    const raw = readWorkflowFile(path);
    const { recipe, warnings } = validateRecipe(raw, {
      filePath: path,
      defaultId: basename(path).replace(/\.json$/iu, ''),
    });
    const payload = {
      ok: true,
      name: recipe.id,
      role: recipe.role,
      description: recipe.description,
      criteria: recipe.criteria.length,
      stages: recipe.stages.map((stage) => ({ id: stage.id, questions: stage.questions.length })),
      warnings,
    };
    if (flags.json) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    } else {
      process.stdout.write(`  ✓ workflow válido: ${recipe.id} (${recipe.role})\n`);
      process.stdout.write(`    criterios: ${recipe.criteria.length} · etapas: ${recipe.stages.length}\n`);
      for (const warning of warnings) process.stdout.write(`    ! ${warning}\n`);
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}

export function workflowSchemaCommand(): never {
  // Zod 4 emite `$schema` y sus propios `definitions` en la raíz; los subimos al
  // sobre para que los `$ref` internos sigan siendo resolubles desde la raíz.
  const generated = z.toJSONSchema(recipeSchema, { target: 'draft-7' });
  const subDefinitions =
    typeof generated.definitions === 'object' && generated.definitions !== null
      ? (generated.definitions as Record<string, unknown>)
      : {};
  delete generated.$schema;
  delete generated.definitions;
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $ref: '#/definitions/Workflow',
    definitions: { ...subDefinitions, Workflow: generated },
  };
  process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
  process.exit(0);
}

export function workflowGuideCommand(flags: WorkflowGuideFlags): never {
  try {
    const payload = workflowGuidePayload();
    if (flags.json) {
      process.stdout.write(JSON.stringify(payload) + '\n');
    } else {
      process.stdout.write('m1 — cómo escribir un workflow\n\n');
      for (const section of payload.sections) {
        process.stdout.write(`## ${section.title}\n${section.body}\n`);
        for (const command of section.commands ?? []) process.stdout.write(`  $ ${command}\n`);
        process.stdout.write('\n');
      }
      process.stdout.write('## Esqueleto mínimo\n');
      process.stdout.write(`${JSON.stringify(payload.skeleton, null, 2)}\n\n`);
      process.stdout.write('Validá con: m1 workflow validate <nombre> · Schema: m1 workflow schema\n');
    }
    process.exit(0);
  } catch (error) {
    fail(error, Boolean(flags.json));
  }
}