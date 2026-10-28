import { M1Error } from './errors.js';

/**
 * Motor de plantillas de `state`: reemplaza `{{path}}` por valores del scope.
 *
 * - Si el string es exactamente `{{path}}`, devuelve el valor resuelto sin
 *   convertir (objetos, arrays, números...).
 * - Si `{{path}}` está embebido en texto, se interpola como string (objetos y
 *   arrays con JSON.stringify).
 * - Recorre objetos y arrays en profundidad sin mutar la entrada.
 */

function templateError(message: string, hint?: string): never {
  throw new M1Error('E_EXPR', message, { hint });
}

function formatKeys(keys: string[]): string {
  if (keys.length === 0) return '(ninguna)';
  return keys.slice(0, 20).join(', ');
}

function availableKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((_, i) => String(i));
  if (value !== null && typeof value === 'object') return Object.keys(value as Record<string, unknown>).sort();
  return [];
}

/**
 * Parte un path en segmentos: `items.0`, `answers.[UX-1].choice`.
 * Los corchetes permiten ids con puntos, guiones o cualquier carácter.
 */
function parsePath(path: string): string[] {
  const segments: string[] = [];
  let current = '';
  let i = 0;

  const flush = () => {
    if (current.length > 0) {
      segments.push(current);
      current = '';
    }
  };

  while (i < path.length) {
    const ch = path[i]!;
    if (ch === '.') {
      flush();
      i += 1;
      continue;
    }
    if (ch === '[') {
      flush();
      const close = path.indexOf(']', i + 1);
      if (close < 0) {
        templateError(
          `plantilla inválida: falta "]" en el path "${path}"`,
          'Cerrá el segmento escapado, por ejemplo {{answers.[UX-1].choice}}.',
        );
      }
      const segment = path.slice(i + 1, close).trim();
      if (segment.length === 0) {
        templateError(`plantilla inválida: segmento vacío en el path "${path}"`, 'Escribí un id dentro de los corchetes.');
      }
      segments.push(segment);
      i = close + 1;
      if (path[i] === '.') i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();

  if (segments.length === 0) {
    templateError('plantilla inválida: path vacío', 'Usá {{nombre}} con un path no vacío.');
  }
  return segments;
}

function missingReference(path: string, level: unknown, segment: string): never {
  const keys = availableKeys(level);
  templateError(
    `referencia de plantilla desconocida: "${path}"`,
    `No existe "${segment}". Claves disponibles: ${formatKeys(keys)}.`,
  );
}

function resolvePath(path: string, vars: Record<string, unknown>): unknown {
  const segments = parsePath(path);
  let current: unknown = vars;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;

    if (current === null || typeof current !== 'object') {
      missingReference(path, current, segment);
    }

    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        missingReference(path, current, segment);
      }
      const index = Number(segment);
      if (index >= current.length) {
        missingReference(path, current, segment);
      }
      current = current[index];
      continue;
    }

    const container = current as Record<string, unknown>;

    if (Object.prototype.hasOwnProperty.call(container, segment)) {
      current = container[segment];
      continue;
    }

    // Fallback: un id puede contener puntos (`UX-1.normalized`). Si el
    // segmento aislado no existe, probamos unirlo con los siguientes.
    let joined = segment;
    let matched = false;
    for (let take = i + 1; take < segments.length; take += 1) {
      joined = `${joined}.${segments[take]!}`;
      if (Object.prototype.hasOwnProperty.call(container, joined)) {
        current = container[joined];
        i = take;
        matched = true;
        break;
      }
    }
    if (!matched) {
      missingReference(path, current, segment);
    }
  }

  return current;
}

function stringifyInterpolated(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const FULL_TEMPLATE = /^\{\{([^{}]+)\}\}$/;

function renderString(input: string, vars: Record<string, unknown>): unknown {
  const full = FULL_TEMPLATE.exec(input);
  if (full && full[1]!.trim().length > 0) {
    return resolvePath(full[1]!.trim(), vars);
  }

  let output = '';
  let i = 0;

  while (i < input.length) {
    const open = input.indexOf('{{', i);
    if (open < 0) {
      output += input.slice(i);
      break;
    }
    output += input.slice(i, open);

    const close = input.indexOf('}}', open + 2);
    if (close < 0) {
      templateError(
        `plantilla sin cerrar: falta "}}" después de la posición ${open}`,
        'Cerrá la referencia con "}}", por ejemplo "{{slot}}".',
      );
    }

    const path = input.slice(open + 2, close).trim();
    if (path.length === 0) {
      templateError('plantilla inválida: referencia vacía "{{}}"', 'Escribí un path dentro de las llaves.');
    }

    output += stringifyInterpolated(resolvePath(path, vars));
    i = close + 2;
  }

  return output;
}

/** Renderiza una plantilla (string, array u objeto) contra las variables dadas. */
export function renderTemplate(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') return renderString(value, vars);
  if (Array.isArray(value)) return value.map((item) => renderTemplate(item, vars));
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      output[key] = renderTemplate((value as Record<string, unknown>)[key], vars);
    }
    return output;
  }
  return value;
}

/** Paths únicos referenciados por la plantilla, en orden de aparición. */
export function collectTemplateRefs(value: unknown): string[] {
  const refs: string[] = [];

  const add = (path: string) => {
    if (!refs.includes(path)) refs.push(path);
  };

  const visit = (node: unknown) => {
    if (typeof node === 'string') {
      let i = 0;
      while (i < node.length) {
        const open = node.indexOf('{{', i);
        if (open < 0) break;
        const close = node.indexOf('}}', open + 2);
        if (close < 0) break;
        const path = node.slice(open + 2, close).trim();
        if (path.length > 0) add(path);
        i = close + 2;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node as Record<string, unknown>)) {
        visit((node as Record<string, unknown>)[key]);
      }
    }
  };

  visit(value);
  return refs;
}
