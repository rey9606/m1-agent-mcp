import { describe, expect, it } from 'vitest';
import { collectTemplateRefs, renderTemplate } from '../src/core/template';
import { M1Error } from '../src/core/errors';

describe('renderTemplate', () => {
  it('devuelve el tipo original cuando el string es exactamente {{path}}', () => {
    const object = { a: 1, nested: [true, null] };
    expect(renderTemplate('{{data}}', { data: object })).toBe(object);
    expect(renderTemplate('{{items}}', { items: [1, 2, 3] })).toEqual([1, 2, 3]);
    expect(renderTemplate('{{score}}', { score: 0.75 })).toBe(0.75);
  });

  it('interpola referencias embebidas en texto', () => {
    expect(renderTemplate('Hola {{name}}!', { name: 'Ana' })).toBe('Hola Ana!');
    expect(
      renderTemplate('estado={{status}} score={{score}}', { status: 'ok', score: 0.5 }),
    ).toBe('estado=ok score=0.5');
    expect(renderTemplate('data={{data}}', { data: { a: 1 } })).toBe('data={"a":1}');
  });

  it('recorre objetos y arrays anidados', () => {
    const template = {
      role: 'Auditor',
      criteria: ['{{a}}', { id: 'b', value: '{{b}}' }],
    };
    expect(renderTemplate(template, { a: 1, b: 'x' })).toEqual({
      role: 'Auditor',
      criteria: [1, { id: 'b', value: 'x' }],
    });
  });

  it('soporta índices numéricos de arrays', () => {
    const vars = { items: [{ name: 'uno' }, { name: 'dos' }] };
    expect(renderTemplate('{{items.1.name}}', vars)).toBe('dos');
    expect(renderTemplate('{{items.0}}', vars)).toEqual({ name: 'uno' });
  });

  it('soporta corchetes para ids con guiones y puntos', () => {
    const vars = { answers: { 'UX-1': { normalized: 0.4, choice: 'si' } } };
    expect(renderTemplate('{{answers.[UX-1].normalized}}', vars)).toBe(0.4);
    expect(renderTemplate('{{answers.[UX-1].choice}}', vars)).toBe('si');
  });

  it('prueba unir segmentos con punto antes de fallar', () => {
    const vars = { answers: { 'UX-1.normalized': 0.9 } };
    expect(renderTemplate('{{answers.UX-1.normalized}}', vars)).toBe(0.9);
  });

  it('reporta una referencia desconocida con hint', () => {
    try {
      renderTemplate('{{answers.missing}}', { answers: { ok: 1 } });
      expect.unreachable('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(M1Error);
      const err = error as M1Error;
      expect(err.code).toBe('E_EXPR');
      expect(err.message).toBe('referencia de plantilla desconocida: "answers.missing"');
      expect(err.hint).toContain('ok');
    }
  });

  it('no muta la plantilla original', () => {
    const template = { a: '{{x}}', b: [{ c: '{{y}}' }] };
    const snapshot = JSON.parse(JSON.stringify(template));
    const output = renderTemplate(template, { x: 1, y: 2 });
    expect(output).toEqual({ a: 1, b: [{ c: 2 }] });
    expect(template).toEqual(snapshot);
    expect(output).not.toBe(template);
    expect((output as { b: unknown[] }).b).not.toBe(template.b);
  });

  it('falla si {{ no está cerrado', () => {
    try {
      renderTemplate('roto {{path', {});
      expect.unreachable('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(M1Error);
      expect((error as M1Error).code).toBe('E_EXPR');
      expect((error as M1Error).message).toContain('sin cerrar');
    }
  });
});

describe('collectTemplateRefs', () => {
  it('devuelve paths únicos en orden de aparición', () => {
    const template = {
      a: '{{one}} y {{two}}',
      b: ['{{two}}', { c: '{{three}}' }],
      d: 42,
    };
    expect(collectTemplateRefs(template)).toEqual(['one', 'two', 'three']);
  });

  it('devuelve un array vacío si no hay referencias', () => {
    expect(collectTemplateRefs({ a: 'texto', b: [1, true, null] })).toEqual([]);
  });
});
