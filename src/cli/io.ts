import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { M1Error } from '../core/errors';
import type { Recipe } from '../schema/recipe';

export interface InputFlags {
  input?: string;
  state?: string;
  stateFile?: string;
  images: string[];
  slot?: string;
  imageSlot?: string;
  stdin?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function pickTextSlot(recipe: Recipe): string | undefined {
  const entries = Object.entries(recipe.input.slots);
  if (entries.length === 1) return entries[0]![0];
  const required = entries.filter(([, s]) => s.required && s.type === 'text');
  if (required.length === 1) return required[0]![0];
  if (recipe.input.slots.state) return 'state';
  return undefined;
}

function pickImageSlot(recipe: Recipe): string | undefined {
  const entries = Object.entries(recipe.input.slots);
  if (entries.length === 1) return entries[0]![0];
  const found = entries.find(([, s]) => s.type === 'image[]' || s.type === 'image');
  return found?.[0];
}

export async function buildRunInput(flags: InputFlags, recipe: Recipe, cwd = process.cwd()): Promise<unknown> {
  let parsedFile: Record<string, unknown> | undefined;

  if (flags.input) {
    const path = isAbsolute(flags.input) ? flags.input : resolve(cwd, flags.input);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new M1Error('E_INPUT', `no se pudo leer el input: ${path}`, { hint: 'verificá la ruta de --input' });
    }
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new M1Error('E_INPUT', 'el input debe ser un objeto JSON con los slots', {
          hint: `ejemplo: { "${pickTextSlot(recipe) ?? 'texto'}": "..." }`,
        });
      }
      parsedFile = value as Record<string, unknown>;
    } catch (e) {
      if (e instanceof M1Error) throw e;
      throw new M1Error('E_INPUT', `el input no es JSON válido: ${path}`, { cause: e });
    }
  }

  let raw: unknown = parsedFile;

  if (flags.stdin) {
    const text = await readStdin();
    if (text.trim() === '') {
      throw new M1Error('E_INPUT', 'stdin vacío', { hint: 'pasá JSON o texto por stdin, o usá --input' });
    }
    try {
      const value = JSON.parse(text) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        raw = { ...(raw as object), ...(value as object) };
      } else {
        raw = value;
      }
    } catch {
      raw = text;
    }
  }

  if (typeof raw === 'string') {
    const slot = flags.slot ?? pickTextSlot(recipe);
    if (!slot) {
      throw new M1Error('E_INPUT', 'no se pudo determinar el slot para el texto', {
        hint: `usá --slot con uno de: ${Object.keys(recipe.input.slots).join(', ')}`,
      });
    }
    raw = { [slot]: raw };
  }

  const obj: Record<string, unknown> = { ...(raw as object | undefined) };

  if (flags.stateFile) {
    const slot = flags.slot ?? pickTextSlot(recipe);
    if (!slot) {
      throw new M1Error('E_INPUT', 'no se pudo determinar el slot para --state-file', {
        hint: `usá --slot con uno de: ${Object.keys(recipe.input.slots).join(', ')}`,
      });
    }
    const path = isAbsolute(flags.stateFile) ? flags.stateFile : resolve(cwd, flags.stateFile);
    try {
      obj[slot] = await readFile(path, 'utf8');
    } catch {
      throw new M1Error('E_INPUT', `no se pudo leer --state-file: ${path}`);
    }
  } else if (flags.state !== undefined) {
    const slot = flags.slot ?? pickTextSlot(recipe);
    if (!slot) {
      throw new M1Error('E_INPUT', 'no se pudo determinar el slot para --state', {
        hint: `usá --slot con uno de: ${Object.keys(recipe.input.slots).join(', ')}`,
      });
    }
    obj[slot] = flags.state;
  }

  if (flags.images.length > 0) {
    const slot = flags.imageSlot ?? pickImageSlot(recipe);
    if (!slot) {
      throw new M1Error('E_INPUT', 'la receta no declara slots de imagen', {
        hint: 'quitá --image o agregá un slot "image[]" a la receta',
      });
    }
    const existing = obj[slot];
    const list = Array.isArray(existing) ? existing : existing ? [existing] : [];
    obj[slot] = [...list, ...flags.images.map((p) => (isAbsolute(p) ? p : resolve(cwd, p)))];
  }

  if (Object.keys(obj).length === 0) {
    throw new M1Error('E_INPUT', 'no hay entrada para evaluar', {
      hint: 'usá --input archivo.json, o --state/--state-file/--image, o --stdin',
    });
  }

  return obj;
}
