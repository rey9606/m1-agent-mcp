import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { M1Error } from '../core/errors';
import { validateRecipe } from '../core/validate';
import type { Recipe } from '../schema/recipe';

/** Nombre de workflow: lo que se escribe en la CLI, sin rutas ni extensión. */
export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Workflows que vienen con el producto (read-only). Tanto en `src/workflows`
 * como en el bundle `dist/cli` estamos a dos niveles de la raíz del repo.
 */
export function builtinWorkflowsDir(): string {
  return resolve(HERE, '..', '..', 'examples');
}

/** Workflows del usuario. `M1_WORKFLOWS_DIR` permite aislarlos en tests. */
export function userWorkflowsDir(): string {
  const override = process.env.M1_WORKFLOWS_DIR?.trim();
  if (override) return resolve(override);
  return join(homedir(), '.config', 'm1-agent', 'workflows');
}

export interface WorkflowEntry {
  name: string;
  description: string;
  role?: string;
  builtin: boolean;
  path: string;
  /** Si el archivo no se pudo leer/parsear, el motivo. */
  error?: string;
  /** Hay un workflow de usuario con el mismo nombre que uno built-in. */
  shadowed?: boolean;
}

export function assertWorkflowName(name: string): void {
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new M1Error('E_USAGE', `nombre de workflow inválido: "${name}"`, {
      hint: 'usá minúsculas, números y guiones (1..64), sin ruta ni .json; ej: mi-copy',
    });
  }
}

function readEntry(path: string, name: string, builtin: boolean): WorkflowEntry {
  const entry: WorkflowEntry = { name, description: '(sin descripción)', builtin, path };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Recipe;
    if (typeof raw.description === 'string' && raw.description.trim() !== '') {
      entry.description = raw.description.trim();
    }
    if (typeof raw.role === 'string' && raw.role.trim() !== '') entry.role = raw.role.trim();
  } catch (error) {
    entry.error = `no se pudo leer ${path}: ${(error as Error).message}`;
  }
  return entry;
}

function readDir(dir: string, builtin: boolean): WorkflowEntry[] {
  if (!existsSync(dir)) return [];
  const entries: WorkflowEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.toLowerCase().endsWith('.json')) continue;
    const name = basename(file, '.json');
    if (!WORKFLOW_NAME_RE.test(name)) continue;
    entries.push(readEntry(join(dir, file), name, builtin));
  }
  return entries;
}

/** Lista built-ins + usuario, detectando nombres duplicados. */
export function listWorkflows(warnings: string[] = []): WorkflowEntry[] {
  const builtins = readDir(builtinWorkflowsDir(), true);
  const users = readDir(userWorkflowsDir(), false);
  const builtinNames = new Set(builtins.map((entry) => entry.name));
  const duplicates = new Set<string>();

  for (const entry of users) {
    if (builtinNames.has(entry.name)) {
      entry.shadowed = true;
      duplicates.add(entry.name);
    }
  }
  if (duplicates.size > 0) {
    warnings.push(
      `nombre(s) de workflow duplicado(s) entre built-in y usuario: ${[...duplicates].join(', ')}. ` +
        'Renombrá o borrá el de usuario para poder resolverlos.',
    );
  }

  return [...builtins, ...users].sort((a, b) => a.name.localeCompare(b.name));
}

function userPath(name: string): string {
  return join(userWorkflowsDir(), `${name}.json`);
}

function builtinPath(name: string): string {
  return join(builtinWorkflowsDir(), `${name}.json`);
}

export function workflowExists(name: string): boolean {
  return existsSync(builtinPath(name)) || existsSync(userPath(name));
}

/** Resuelve por nombre. Falla si no existe o si hay duplicado. */
export function findWorkflow(name: string): WorkflowEntry {
  assertWorkflowName(name);
  const builtin = existsSync(builtinPath(name));
  const user = existsSync(userPath(name));

  if (builtin && user) {
    throw new M1Error('E_CONFIG', `hay dos workflows llamados "${name}"`, {
      hint: `borrá o renombrá ${userPath(name)} (el built-in no se puede tocar)`,
    });
  }

  if (user) return readEntry(userPath(name), name, false);
  if (builtin) return readEntry(builtinPath(name), name, true);

  const available = listWorkflows()
    .filter((entry) => !entry.shadowed)
    .map((entry) => entry.name);
  throw new M1Error('E_INPUT', `no existe el workflow "${name}"`, {
    hint:
      available.length > 0
        ? `disponibles: ${available.join(', ')}. Creá uno con \`m1 workflow new ${name}\``
        : `creá uno con \`m1 workflow new ${name}\``,
  });
}

/**
 * Acepta un nombre (`copy-checker`) o, como escape hatch para CI, una ruta
 * (`./mi.json`). Nunca se muestra una ruta en la salida humana.
 */
export function resolveWorkflowPath(ref: string, cwd = process.cwd()): string {
  const isPath = isAbsolute(ref) || /[\\/]/u.test(ref) || /\.json$/iu.test(ref);
  if (!isPath) return findWorkflow(ref).path;

  const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
  if (!existsSync(path)) {
    const name = basename(ref, '.json');
    throw new M1Error('E_INPUT', `no existe el archivo de workflow: ${path}`, {
      hint: `si el workflow está registrado, usá sólo el nombre: \`m1 run ${name}\``,
    });
  }
  return path;
}

export function readWorkflowFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new M1Error('E_INPUT', `no se pudo leer el workflow: ${path}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new M1Error('E_VALIDATION', `el workflow no es JSON válido: ${path}`, {
      hint: 'revisá comas y comillas',
      cause: error,
    });
  }
}

export function readWorkflowText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new M1Error('E_INPUT', `no se pudo leer el workflow: ${path}`, { cause: error });
  }
}

function writeWorkflow(name: string, raw: unknown): string {
  const path = userPath(name);
  mkdirSync(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(raw, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, payload, 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, payload, 'utf8');
    rmSync(tmp, { force: true });
  }
  return path;
}

export interface NewWorkflowOptions {
  from?: string;
  role?: string;
  description?: string;
}

export function workflowSkeleton(name: string, options: NewWorkflowOptions = {}): Record<string, unknown> {
  const description =
    options.description ?? `Workflow ${name}: describí en una línea qué evalúa y para qué se usa.`;
  return {
    schema: 'm1agent/recipe@1',
    id: name,
    role: options.role ?? 'Evaluador',
    description,
    whenToUse: 'Cuando necesites una evaluación estructurada antes de publicar o decidir.',
    input: {
      slots: {
        state: {
          type: 'text',
          required: true,
          description: 'El contenido o la situación a evaluar.',
        },
      },
      state: { state: '{{state}}' },
      images: [],
    },
    criteria: [
      {
        id: 'calidad',
        name: 'Calidad',
        type: 'score',
        instructions: '¿Qué tan buena es la entrada para el objetivo declarado?',
        criteria: ['Mala', 'Regular', 'Buena', 'Excelente'],
        polarity: 'positive',
        passAt: 0.66,
        weight: 1,
        severity: 'major',
        remediation: 'Corregí lo señalado y volvé a ejecutar el workflow.',
      },
    ],
    stages: [{ id: 'base', questions: ['calidad'] }],
    derived: [],
    acceptance: [{ id: 'calidad-minima', expr: 'calidad >= 0.66', severity: 'major' }],
  };
}

export function createWorkflow(name: string, options: NewWorkflowOptions = {}): { name: string; path: string } {
  assertWorkflowName(name);
  if (workflowExists(name)) {
    throw new M1Error('E_USAGE', `ya existe un workflow llamado "${name}"`, {
      hint: `elegí otro nombre o editalo con \`m1 workflow show ${name}\``,
    });
  }

  let raw: Record<string, unknown>;
  if (options.from) {
    const source = findWorkflow(options.from);
    const parsed = readWorkflowFile(source.path);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new M1Error('E_VALIDATION', `el workflow base "${options.from}" no es un objeto JSON`);
    }
    raw = { ...(parsed as Record<string, unknown>), id: name };
    if (options.role) raw.role = options.role;
    if (options.description) raw.description = options.description;
  } else {
    raw = workflowSkeleton(name, options);
  }

  validateRecipe(raw, { defaultId: name });
  const path = writeWorkflow(name, raw);
  return { name, path };
}

export function importWorkflow(
  file: string,
  options: { name?: string } = {},
): { name: string; path: string; warnings: string[] } {
  const source = resolve(file);
  const raw = readWorkflowFile(source);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new M1Error('E_VALIDATION', 'el workflow importado debe ser un objeto JSON');
  }

  const record = raw as Record<string, unknown>;
  const name =
    options.name ?? (typeof record.id === 'string' ? record.id : basename(source, '.json'));
  assertWorkflowName(name);
  if (workflowExists(name)) {
    throw new M1Error('E_USAGE', `ya existe un workflow llamado "${name}"`, {
      hint: 'importá con --name <otro-nombre> o borrá el existente',
    });
  }

  record.id = name;
  const { warnings } = validateRecipe(record, { defaultId: name });
  const path = writeWorkflow(name, record);
  return { name, path, warnings };
}

export function exportWorkflow(name: string): { name: string; builtin: boolean; text: string } {
  const entry = findWorkflow(name);
  return { name, builtin: entry.builtin, text: readWorkflowText(entry.path) };
}

export function deleteWorkflow(name: string): string {
  const entry = findWorkflow(name);
  if (entry.builtin) {
    throw new M1Error('E_USAGE', `el workflow built-in "${name}" no se puede borrar`, {
      hint: `duplicalo con \`m1 workflow new mi-${name} --from ${name}\` y editá la copia`,
    });
  }
  rmSync(entry.path, { force: true });
  return entry.path;
}

export function editableWorkflowPath(name: string): string {
  const entry = findWorkflow(name);
  if (entry.builtin) {
    throw new M1Error('E_USAGE', `el workflow built-in "${name}" es de sólo lectura`, {
      hint: `duplicalo con \`m1 workflow new mi-${name} --from ${name}\` y editá la copia`,
    });
  }
  return entry.path;
}