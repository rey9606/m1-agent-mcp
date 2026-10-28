import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { M1Error } from '../src/core/errors.js';
import {
  assertWorkflowName,
  builtinWorkflowsDir,
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
  workflowExists,
} from '../src/workflows/store.js';

/**
 * Tests unitarios del registry de workflows. Cada test corre con
 * `M1_WORKFLOWS_DIR` apuntando a un directorio temporal, así nunca se toca
 * `~/.config/m1-agent/workflows`; los built-in salen de `examples/`.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UX_BUILTIN = join(REPO, 'examples', 'ux-checker.json');

const originalDir = process.env.M1_WORKFLOWS_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm1-workflows-'));
  process.env.M1_WORKFLOWS_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalDir === undefined) delete process.env.M1_WORKFLOWS_DIR;
  else process.env.M1_WORKFLOWS_DIR = originalDir;
});

function m1ErrorOf(fn: () => unknown): M1Error {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof M1Error)) throw error;
    return error;
  }
  throw new Error('se esperaba un M1Error y no se lanzó nada');
}

/** Copia el built-in ux-checker con otro id en un subdirectorio (fuera del registry). */
function writeSourceJson(file: string, overrides: Record<string, unknown> = {}): string {
  const sources = join(dir, 'fuentes');
  mkdirSync(sources, { recursive: true });
  const base = JSON.parse(readFileSync(UX_BUILTIN, 'utf8')) as Record<string, unknown>;
  const path = join(sources, file);
  writeFileSync(path, JSON.stringify({ ...base, ...overrides }, null, 2));
  return path;
}

/** Igual, pero dentro del directorio de usuario (para probar shadowed y rutas). */
function writeUserJson(file: string, overrides: Record<string, unknown> = {}): string {
  const base = JSON.parse(readFileSync(UX_BUILTIN, 'utf8')) as Record<string, unknown>;
  const path = join(dir, file);
  writeFileSync(path, JSON.stringify({ ...base, ...overrides }, null, 2));
  return path;
}

describe('nombres de workflow', () => {
  it('acepta minúsculas, números y guiones', () => {
    for (const name of ['mi-copy', 'a', 'copy2', 'x'.repeat(64), 'ux-1']) {
      expect(() => assertWorkflowName(name)).not.toThrow();
    }
  });

  it('rechaza mayúsculas, rutas, .json, guiones bajos y nombres vacíos', () => {
    for (const name of ['Mi-Copy', 'mi/copy', 'mi\\copy', 'mi.json', 'mi_copy', '', '-mi', 'mi copy', 'x'.repeat(65)]) {
      const error = m1ErrorOf(() => assertWorkflowName(name));
      expect(error.code).toBe('E_USAGE');
      expect(error.message).toContain('nombre de workflow inválido');
    }
  });

  it('usa M1_WORKFLOWS_DIR para el directorio de usuario', () => {
    expect(userWorkflowsDir()).toBe(resolve(dir));
    expect(existsSync(join(builtinWorkflowsDir(), 'ux-checker.json'))).toBe(true);
  });
});

describe('createWorkflow / listWorkflows / findWorkflow', () => {
  it('crea un workflow de usuario, lo lista y lo resuelve', () => {
    const created = createWorkflow('mi-copy', {
      role: 'editor de copy',
      description: 'Evalúa copy de landing',
    });

    expect(created.name).toBe('mi-copy');
    expect(created.path).toBe(join(dir, 'mi-copy.json'));
    expect(existsSync(created.path)).toBe(true);

    const raw = readWorkflowFile(created.path) as { id?: string; role?: string; description?: string };
    expect(raw.id).toBe('mi-copy');
    expect(raw.role).toBe('editor de copy');
    expect(raw.description).toBe('Evalúa copy de landing');

    const entry = findWorkflow('mi-copy');
    expect(entry).toMatchObject({
      name: 'mi-copy',
      builtin: false,
      description: 'Evalúa copy de landing',
      role: 'editor de copy',
    });

    const listed = listWorkflows();
    expect(listed.some((item) => item.name === 'mi-copy' && !item.builtin)).toBe(true);
    expect(listed.some((item) => item.name === 'ux-checker' && item.builtin)).toBe(true);
  });

  it('con --from copia un built-in y cambia el id', () => {
    const builtin = readWorkflowFile(UX_BUILTIN) as { criteria: unknown[] };
    const created = createWorkflow('mi-ux', { from: 'ux-checker', description: 'Copia propia' });

    const raw = readWorkflowFile(created.path) as { id?: string; criteria?: unknown[]; description?: string };
    expect(raw.id).toBe('mi-ux');
    expect(raw.description).toBe('Copia propia');
    expect(raw.criteria).toHaveLength(builtin.criteria.length);
    expect(findWorkflow('mi-ux').builtin).toBe(false);
  });

  it('rechaza crear un workflow que ya existe', () => {
    createWorkflow('mi-copy');

    const error = m1ErrorOf(() => createWorkflow('mi-copy'));
    expect(error.code).toBe('E_USAGE');
    expect(error.message).toContain('ya existe un workflow');

    // tampoco se puede pisar un built-in
    expect(m1ErrorOf(() => createWorkflow('ux-checker')).code).toBe('E_USAGE');
  });

  it('rechaza un nombre inválido antes de escribir nada', () => {
    expect(m1ErrorOf(() => createWorkflow('Mi-Copy')).code).toBe('E_USAGE');
    expect(existsSync(join(dir, 'Mi-Copy.json'))).toBe(false);
  });
});

describe('importWorkflow / exportWorkflow', () => {
  it('exporta un workflow y lo reimporta con --name', () => {
    createWorkflow('mi-copy', { description: 'Original' });

    const exported = exportWorkflow('mi-copy');
    expect(exported.name).toBe('mi-copy');
    expect(exported.builtin).toBe(false);

    const file = join(dir, 'fuentes', 'exportado.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, exported.text);

    const imported = importWorkflow(file, { name: 'mi-copia' });
    expect(imported.name).toBe('mi-copia');
    expect(imported.path).toBe(join(dir, 'mi-copia.json'));
    expect((readWorkflowFile(imported.path) as { id?: string }).id).toBe('mi-copia');
    expect(findWorkflow('mi-copia').description).toBe('Original');
  });

  it('sin --name usa el id del archivo importado', () => {
    const file = writeSourceJson('ajeno.json', { id: 'ajeno' });

    const imported = importWorkflow(file);
    expect(imported.name).toBe('ajeno');
    expect(workflowExists('ajeno')).toBe(true);
  });

  it('rechaza importar con un nombre inválido o ya existente', () => {
    const file = writeSourceJson('ajeno.json', { id: 'ajeno' });

    expect(m1ErrorOf(() => importWorkflow(file, { name: 'Ajeno' })).code).toBe('E_USAGE');

    createWorkflow('mi-copy');
    expect(m1ErrorOf(() => importWorkflow(file, { name: 'mi-copy' })).code).toBe('E_USAGE');
  });
});

describe('deleteWorkflow', () => {
  it('no permite borrar un built-in', () => {
    const error = m1ErrorOf(() => deleteWorkflow('ux-checker'));
    expect(error.code).toBe('E_USAGE');
    expect(error.message).toContain('built-in');
    expect(existsSync(join(builtinWorkflowsDir(), 'ux-checker.json'))).toBe(true);
  });

  it('borra un workflow de usuario', () => {
    createWorkflow('mi-copy');
    expect(m1ErrorOf(() => editableWorkflowPath('ux-checker')).code).toBe('E_USAGE');

    const path = deleteWorkflow('mi-copy');
    expect(path).toBe(join(dir, 'mi-copy.json'));
    expect(workflowExists('mi-copy')).toBe(false);
  });
});

describe('duplicados y resolución de rutas', () => {
  it('un workflow de usuario con nombre de built-in queda shadowed', () => {
    const userFile = join(userWorkflowsDir(), 'ux-checker.json');
    mkdirSync(dirname(userFile), { recursive: true });
    copyFileSync(UX_BUILTIN, userFile);

    const warnings: string[] = [];
    const entries = listWorkflows(warnings);
    const ux = entries.filter((entry) => entry.name === 'ux-checker');

    expect(ux).toHaveLength(2);
    expect(ux.find((entry) => entry.builtin)?.shadowed).toBeUndefined();
    expect(ux.find((entry) => !entry.builtin)?.shadowed).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ux-checker');

    // el nombre es ambiguo: no se resuelve
    expect(m1ErrorOf(() => findWorkflow('ux-checker')).code).toBe('E_CONFIG');
  });

  it('resolveWorkflowPath acepta nombre y ruta', () => {
    const created = createWorkflow('mi-copy');

    expect(resolveWorkflowPath('mi-copy')).toBe(created.path);
    expect(resolveWorkflowPath('ux-checker')).toBe(join(builtinWorkflowsDir(), 'ux-checker.json'));

    const loose = writeUserJson('suelto.json', { id: 'suelto' });
    expect(resolveWorkflowPath(loose)).toBe(loose);
    expect(resolveWorkflowPath('./suelto.json', dir)).toBe(loose);
  });

  it('resolveWorkflowPath con ruta inexistente tira E_INPUT', () => {
    const error = m1ErrorOf(() => resolveWorkflowPath(join(dir, 'no-existe.json')));
    expect(error.code).toBe('E_INPUT');
    expect(error.message).toContain('no existe el archivo de workflow');
  });

  it('un JSON roto se reporta como error en el listado, sin explotar', () => {
    writeFileSync(join(dir, 'roto.json'), '{ esto no es json');

    const entries = listWorkflows();
    const broken = entries.find((entry) => entry.name === 'roto');

    expect(broken?.error).toContain('no se pudo leer');
    expect(m1ErrorOf(() => readWorkflowFile(join(dir, 'roto.json'))).code).toBe('E_VALIDATION');
  });
});