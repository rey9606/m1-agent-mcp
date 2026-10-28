import { describe, expect, it } from 'vitest';
import { collectRefs, evaluateExpression, parseExpression } from '../src/core/expr';
import { M1Error } from '../src/core/errors';

describe('evaluateExpression', () => {
  it('respeta la precedencia aritmética estándar', () => {
    expect(evaluateExpression('1 + 2 * 3', {})).toBe(7);
    expect(evaluateExpression('(1 + 2) * 3', {})).toBe(9);
    expect(evaluateExpression('10 % 3 + 1', {})).toBe(2);
  });

  it('aplica unarios y paréntesis', () => {
    expect(evaluateExpression('-(2 + 3) * 2', {})).toBe(-10);
    expect(evaluateExpression('!false', {})).toBe(true);
    expect(evaluateExpression('!(score > 0.5)', { score: 0.2 })).toBe(true);
  });

  it('compara números coercicionando strings numéricos', () => {
    expect(evaluateExpression('score >= "0.75"', { score: 0.8 })).toBe(true);
    expect(evaluateExpression('"2" < 10', {})).toBe(true);
    expect(evaluateExpression('"abc" == "abc"', {})).toBe(true);
    expect(evaluateExpression('"1" == 1', {})).toBe(true);
    expect(evaluateExpression('"1" != 1', {})).toBe(false);
  });

  it('evalúa strings con escapes', () => {
    expect(evaluateExpression('"a\\"b"', {})).toBe('a"b');
    expect(evaluateExpression('"a\\\\b"', {})).toBe('a\\b');
    expect(evaluateExpression('"linea\\n"', {})).toBe('linea\n');
  });

  it('evalúa operadores lógicos con cortocircuito', () => {
    expect(evaluateExpression('a && (b || false)', { a: true, b: false })).toBe(false);
    expect(evaluateExpression('a || b', { a: false, b: true })).toBe(true);
    // El cortocircuito evita resolver una referencia inexistente.
    expect(evaluateExpression('false && noExiste', {})).toBe(false);
  });

  it('trata UX-1 como un único identificador', () => {
    expect(evaluateExpression('UX-1 >= 0.5', { 'UX-1': 0.7 })).toBe(true);
    expect(collectRefs('UX-1 > 0')).toEqual(['UX-1']);
  });

  it('admite identificadores escapados con corchetes', () => {
    expect(evaluateExpression('[UX-1] >= 0.5', { 'UX-1': 0.7 })).toBe(true);
    expect(evaluateExpression('[UX-1].normalized > 0', { 'UX-1.normalized': 0.4 })).toBe(true);
  });

  it('exige espacios para la resta cuando hay guiones en ids', () => {
    expect(evaluateExpression('a - b', { a: 5, b: 3 })).toBe(2);
    expect(() => evaluateExpression('a-b', { a: 5, b: 3 })).toThrowError(/referencia desconocida: "a-b"/);
  });

  it('explica errores de sintaxis con la posición', () => {
    try {
      evaluateExpression('1 + * 2', {});
      expect.unreachable('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(M1Error);
      expect((error as M1Error).code).toBe('E_EXPR');
      expect((error as M1Error).message).toContain('posición 4');
    }
  });

  it('falla con división por cero y hint accionable', () => {
    try {
      evaluateExpression('1 / 0', {});
      expect.unreachable('debió lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(M1Error);
      const err = error as M1Error;
      expect(err.code).toBe('E_EXPR');
      expect(err.message).toContain('división por cero');
      expect(err.hint).toBeTruthy();
    }
  });

  it('reporta referencias desconocidas con las claves disponibles', () => {
    try {
      evaluateExpression('c > 1', { b: 1, a: 2 });
      expect.unreachable('debió lanzar');
    } catch (error) {
      const err = error as M1Error;
      expect(err.code).toBe('E_EXPR');
      expect(err.message).toBe('referencia desconocida: "c"');
      expect(err.hint).toContain('a, b');
    }
  });

  it('devuelve el valor tal cual para un identificador suelto', () => {
    expect(evaluateExpression('status', { status: 'ok' })).toBe('ok');
    expect(evaluateExpression('score', { score: 0.42 })).toBe(0.42);
    expect(evaluateExpression('enabled', { enabled: true })).toBe(true);
  });
});

describe('parseExpression / collectRefs', () => {
  it('devuelve un AST con refs únicas en orden de aparición', () => {
    const { ast, refs } = parseExpression('b + a + b > c && true');
    expect(ast.kind).toBe('binary');
    expect(refs).toEqual(['b', 'a', 'c']);
  });

  it('excluye true/false/null de las referencias', () => {
    expect(collectRefs('true && x || null == y')).toEqual(['x', 'y']);
    expect(collectRefs('null == null')).toEqual([]);
  });

  it('soporta literales null y booleanos', () => {
    expect(evaluateExpression('null == null', {})).toBe(true);
    expect(evaluateExpression('true != false', {})).toBe(true);
  });
});
