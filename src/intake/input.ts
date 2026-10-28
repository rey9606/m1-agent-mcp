import { M1Error } from '../core/errors';
import type { Recipe, Slot } from '../schema/recipe';
import {
  MAX_IMAGES,
  assertBodyBudget,
  assertImageBudget,
  loadImage,
  type LoadedImage,
} from './images';

export interface ResolvedInput {
  vars: Record<string, unknown>;
  imagesBySlot: Record<string, LoadedImage[]>;
}

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exampleFor(name: string, slot: Slot): string {
  switch (slot.type) {
    case 'text':
      return `{"${name}": "texto"}`;
    case 'json':
      return `{"${name}": {}}`;
    case 'image':
      return `{"${name}": "captura.png"}`;
    case 'image[]':
      return `{"${name}": ["captura1.png", "captura2.png"]}`;
    default:
      return `{"${name}": ...}`;
  }
}

function invalidSlot(name: string, slot: Slot, detail: string): M1Error {
  return new M1Error('E_INPUT', `slot "${name}": ${detail}`, {
    hint: `tipo esperado: ${slot.type}; ejemplo: ${exampleFor(name, slot)}`,
    details: { path: `input.${name}`, expected: slot.type },
  });
}

function isImageRef(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (isPlainObject(value)) return typeof value.base64 === 'string' && value.base64.length > 0;
  return false;
}

function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : 0;
  } catch {
    // Valores no serializables no deberían llegar acá (raw viene de JSON),
    // pero la estimación nunca debe romper la resolución.
    return 0;
  }
}

/**
 * Resuelve el sobre de entrada contra la receta: valida slots, carga imágenes
 * y aplica los límites de la API. No modifica `raw`.
 */
export async function resolveInput(
  raw: unknown,
  recipe: Recipe,
  opts: { cwd?: string } = {},
): Promise<ResolvedInput> {
  if (!isPlainObject(raw)) {
    const detail = typeof raw === 'string' ? 'se esperaba un objeto JSON con los slots' : 'la entrada debe ser un objeto con los slots';
    throw new M1Error('E_INPUT', detail, {
      hint: 'se esperaba un objeto JSON con los slots',
      details: { received: typeof raw },
    });
  }

  const vars: PlainObject = { ...raw };
  const imagesBySlot: Record<string, LoadedImage[]> = {};
  const allImages: LoadedImage[] = [];

  for (const [name, slot] of Object.entries(recipe.input.slots)) {
    const value = raw[name];
    const missing = value === undefined || value === null;

    if (missing) {
      if (slot.required) {
        throw new M1Error('E_INPUT', `falta el slot obligatorio "${name}"`, {
          hint: `tipo esperado: ${slot.type}; ejemplo: ${exampleFor(name, slot)}`,
          details: { path: `input.${name}`, expected: slot.type },
        });
      }
      // Defaults para que las plantillas `{{slot}}` de la receta siempre resuelvan.
      if (slot.type === 'text') vars[name] = '';
      else if (slot.type === 'image[]') vars[name] = [];
      else vars[name] = null;
      continue;
    }

    switch (slot.type) {
      case 'text': {
        if (typeof value !== 'string' || value.trim().length === 0) {
          throw invalidSlot(name, slot, 'debe ser un string no vacío');
        }
        break;
      }
      case 'json': {
        // Cualquier valor JSON es válido.
        break;
      }
      case 'image': {
        if (!isImageRef(value)) {
          throw invalidSlot(name, slot, 'debe ser un path, una data URL o { content_type?, base64 }');
        }
        const image = await loadImage(value as string | { content_type?: string; base64: string }, opts);
        imagesBySlot[name] = [image];
        allImages.push(image);
        break;
      }
      case 'image[]': {
        const max = slot.max ?? MAX_IMAGES;
        if (!Array.isArray(value)) {
          throw invalidSlot(name, slot, `debe ser un array de 1 a ${max} imágenes`);
        }
        if (value.length < 1) {
          throw invalidSlot(name, slot, `debe tener al menos 1 imagen (máximo ${max})`);
        }
        if (value.length > max) {
          throw invalidSlot(name, slot, `admite hasta ${max} imágenes (recibidas ${value.length})`);
        }
        const loaded: LoadedImage[] = [];
        for (const [index, item] of value.entries()) {
          if (!isImageRef(item)) {
            throw new M1Error(
              'E_INPUT',
              `slot "${name}[${index}]": debe ser un path, una data URL o { content_type?, base64 }`,
              {
                hint: `tipo esperado: image; ejemplo: ${exampleFor(name, slot)}`,
                details: { path: `input.${name}[${index}]`, expected: 'image' },
              },
            );
          }
          loaded.push(await loadImage(item as string | { content_type?: string; base64: string }, opts));
        }
        imagesBySlot[name] = loaded;
        allImages.push(...loaded);
        break;
      }
      default: {
        // El schema de receta no permite otros tipos.
        throw invalidSlot(name, slot, 'tipo de slot desconocido');
      }
    }
  }

  assertImageBudget(allImages);

  const decodedBytes = allImages.reduce((sum, img) => sum + img.bytes, 0);
  assertBodyBudget(Math.ceil((decodedBytes * 4) / 3) + jsonBytes(vars));

  return { vars, imagesBySlot };
}
