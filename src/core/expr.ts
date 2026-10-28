import { M1Error } from './errors.js';

/**
 * Mini-lenguaje de expresiones para `when`, `acceptance` y `derived`.
 *
 * No usa `eval` ni `Function`: tokeniza, parsea a un AST propio y evalúa.
 * Los ids de criterio pueden contener guiones (`UX-1`): si un token empieza
 * con letra o `_`, se consume todo `[A-Za-z0-9_.-]*`, por lo que la resta
 * necesita espacios (`a - b`). Un id arbitrario puede escaparse con corchetes:
 * `[UX-1]` equivale a `UX-1` y `[UX-1].normalized` a `UX-1.normalized`.
 */

export type ExprScope = Record<string, number | string | boolean>;

export type BinaryOperator = '||' | '&&' | '==' | '!=' | '>' | '>=' | '<' | '<=' | '+' | '-' | '*' | '/' | '%';
export type UnaryOperator = '!' | '-';

export type Node =
  | { kind: 'number'; value: number; start: number }
  | { kind: 'string'; value: string; start: number }
  | { kind: 'boolean'; value: boolean; start: number }
  | { kind: 'null'; start: number }
  | { kind: 'ident'; name: string; start: number }
  | { kind: 'unary'; op: UnaryOperator; operand: Node; start: number }
  | { kind: 'binary'; op: BinaryOperator; left: Node; right: Node; start: number };

/** Alias explícito para consumidores que prefieran nombrar el tipo del AST. */
export type ExprNode = Node;

type Value = number | string | boolean | null;

type Token =
  | { type: 'number'; value: number; start: number }
  | { type: 'string'; value: string; start: number }
  | { type: 'ident'; value: string; start: number }
  | { type: 'operator'; value: string; start: number }
  | { type: 'eof'; start: number };

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_.-]/;
const DIGIT = /[0-9]/;

function exprError(message: string, position: number, hint?: string): never {
  throw new M1Error('E_EXPR', message, { hint });
}

function describeChar(ch: string | undefined): string {
  if (ch === undefined) return 'fin de expresión';
  if (ch === '\n') return 'salto de línea';
  return `"${ch}"`;
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

class Lexer {
  private pos = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    const src = this.source;

    while (this.pos < src.length) {
      const ch = src[this.pos]!;

      if (/\s/.test(ch)) {
        this.pos += 1;
        continue;
      }

      if (ch === '(' || ch === ')') {
        tokens.push({ type: 'operator', value: ch, start: this.pos });
        this.pos += 1;
        continue;
      }

      if (ch === '[') {
        const start = this.pos;
        tokens.push({ type: 'ident', value: this.readBracketIdentifier(), start });
        continue;
      }

      if (ch === '"' || ch === "'") {
        tokens.push(this.readString());
        continue;
      }

      if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(src[this.pos + 1] ?? ''))) {
        tokens.push(this.readNumber());
        continue;
      }

      if (IDENT_START.test(ch)) {
        tokens.push(this.readIdentifier());
        continue;
      }

      const two = src.slice(this.pos, this.pos + 2);
      if (two === '||' || two === '&&' || two === '==' || two === '!=' || two === '>=' || two === '<=') {
        tokens.push({ type: 'operator', value: two, start: this.pos });
        this.pos += 2;
        continue;
      }

      if (ch === '!' || ch === '>' || ch === '<' || ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') {
        tokens.push({ type: 'operator', value: ch, start: this.pos });
        this.pos += 1;
        continue;
      }

      const hint =
        ch === '='
          ? 'Usá "==" para comparar igualdad.'
          : ch === '&' || ch === '|'
            ? `Usá "${ch}${ch}" para el operador lógico.`
            : 'Revisá la sintaxis de la expresión.';
      exprError(`carácter inesperado ${describeChar(ch)} en la posición ${this.pos}`, this.pos, hint);
    }

    tokens.push({ type: 'eof', start: src.length });
    return tokens;
  }

  private readNumber(): Token {
    const start = this.pos;
    const src = this.source;
    while (this.pos < src.length && DIGIT.test(src[this.pos]!)) this.pos += 1;
    if (src[this.pos] === '.' && DIGIT.test(src[this.pos + 1] ?? '')) {
      this.pos += 1;
      while (this.pos < src.length && DIGIT.test(src[this.pos]!)) this.pos += 1;
    }
    const raw = src.slice(start, this.pos);
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      exprError(`número inválido "${raw}" en la posición ${start}`, start, 'Usá números decimales simples, por ejemplo 0.75.');
    }
    return { type: 'number', value, start };
  }

  private readString(): Token {
    const start = this.pos;
    const quote = this.source[this.pos]!;
    this.pos += 1;
    let value = '';
    const src = this.source;

    while (this.pos < src.length) {
      const ch = src[this.pos]!;
      if (ch === quote) {
        this.pos += 1;
        return { type: 'string', value, start };
      }
      if (ch === '\\') {
        const next = src[this.pos + 1];
        if (next === undefined) break;
        if (next === '"' || next === "'" || next === '\\') {
          value += next;
          this.pos += 2;
          continue;
        }
        if (next === 'n') {
          value += '\n';
          this.pos += 2;
          continue;
        }
        if (next === 't') {
          value += '\t';
          this.pos += 2;
          continue;
        }
        exprError(
          `escape inválido "\\${next}" en la posición ${this.pos}`,
          this.pos,
          'Escapes admitidos: \\" \\\' \\\\ \\n \\t.',
        );
      }
      value += ch;
      this.pos += 1;
    }

    exprError(
      `string sin cerrar en la posición ${start}`,
      start,
      `Cerrá el string con la misma comilla (${quote}).`,
    );
  }

  private readIdentifier(): Token {
    const start = this.pos;
    const src = this.source;
    this.pos += 1;
    while (this.pos < src.length && IDENT_PART.test(src[this.pos]!)) this.pos += 1;
    return { type: 'ident', value: src.slice(start, this.pos), start };
  }

  private readBracketIdentifier(): string {
    const src = this.source;
    const start = this.pos;
    this.pos += 1; // '['
    let name = '';

    const close = src.indexOf(']', this.pos);
    if (close < 0) {
      exprError(
        `corchete sin cerrar en la posición ${start}`,
        start,
        'Cerrá el identificador escapado con "]", por ejemplo [UX-1].',
      );
    }
    name += src.slice(this.pos, close);
    this.pos = close + 1;

    // Continuación de path: `[UX-1].normalized`, `a[0]`, etc.
    while (this.pos < src.length) {
      const ch = src[this.pos]!;
      if (ch === '[') {
        const nextClose = src.indexOf(']', this.pos + 1);
        if (nextClose < 0) {
          exprError(
            `corchete sin cerrar en la posición ${this.pos}`,
            this.pos,
            'Cerrá el identificador escapado con "]".',
          );
        }
        name += src.slice(this.pos + 1, nextClose);
        this.pos = nextClose + 1;
        continue;
      }
      if (IDENT_PART.test(ch)) {
        const runStart = this.pos;
        while (this.pos < src.length && IDENT_PART.test(src[this.pos]!)) this.pos += 1;
        name += src.slice(runStart, this.pos);
        continue;
      }
      break;
    }

    if (name.length === 0) {
      exprError(
        `identificador vacío en la posición ${start}`,
        start,
        'Escribí un id entre corchetes, por ejemplo [UX-1].',
      );
    }
    return name;
  }
}

type OperatorToken = Extract<Token, { type: 'operator' }>;

class Parser {
  private index = 0;
  private readonly tokens: Token[];
  private readonly source: string;
  readonly refs: string[] = [];

  constructor(tokens: Token[], source: string) {
    this.tokens = tokens;
    this.source = source;
  }

  parse(): Node {
    if (this.peek().type === 'eof') {
      exprError('expresión vacía', 0, 'Escribí una expresión, por ejemplo "score >= 0.5".');
    }
    const node = this.parseOr();
    const token = this.peek();
    if (token.type !== 'eof') {
      this.unexpected(token, 'sobra contenido al final de la expresión');
    }
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private advance(): Token {
    const token = this.tokens[this.index]!;
    this.index += 1;
    return token;
  }

  private matchOperator(...ops: string[]): OperatorToken | null {
    const token = this.peek();
    if (token.type === 'operator' && ops.includes(token.value)) {
      this.index += 1;
      return token;
    }
    return null;
  }

  private expectOperator(op: string): OperatorToken {
    const token = this.matchOperator(op);
    if (!token) {
      this.unexpected(this.peek(), `se esperaba "${op}"`);
    }
    return token;
  }

  private unexpected(token: Token, reason: string): never {
    const where = token.type === 'eof' ? `al final de la expresión (posición ${token.start})` : `en la posición ${token.start}`;
    const found = token.type === 'eof' ? 'fin de expresión' : describeChar(this.source.slice(token.start, token.start + 1));
    exprError(
      `error de sintaxis ${where}: ${reason}; se encontró ${found}`,
      token.start,
      'Revisá paréntesis, operadores y operandos. Para ids con guiones usá espacios en la resta o corchetes.',
    );
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    let token: Token | null;
    while ((token = this.matchOperator('||'))) {
      const right = this.parseAnd();
      left = { kind: 'binary', op: '||', left, right, start: token.start };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseEquality();
    let token: Token | null;
    while ((token = this.matchOperator('&&'))) {
      const right = this.parseEquality();
      left = { kind: 'binary', op: '&&', left, right, start: token.start };
    }
    return left;
  }

  private parseEquality(): Node {
    let left = this.parseComparison();
    let token: Token | null;
    while ((token = this.matchOperator('==', '!='))) {
      const right = this.parseComparison();
      left = { kind: 'binary', op: token.value as BinaryOperator, left, right, start: token.start };
    }
    return left;
  }

  private parseComparison(): Node {
    let left = this.parseAdditive();
    let token: Token | null;
    while ((token = this.matchOperator('>', '>=', '<', '<='))) {
      const right = this.parseAdditive();
      left = { kind: 'binary', op: token.value as BinaryOperator, left, right, start: token.start };
    }
    return left;
  }

  private parseAdditive(): Node {
    let left = this.parseMultiplicative();
    let token: Token | null;
    while ((token = this.matchOperator('+', '-'))) {
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op: token.value as BinaryOperator, left, right, start: token.start };
    }
    return left;
  }

  private parseMultiplicative(): Node {
    let left = this.parseUnary();
    let token: Token | null;
    while ((token = this.matchOperator('*', '/', '%'))) {
      const right = this.parseUnary();
      left = { kind: 'binary', op: token.value as BinaryOperator, left, right, start: token.start };
    }
    return left;
  }

  private parseUnary(): Node {
    const token = this.matchOperator('!', '-');
    if (token) {
      const operand = this.parseUnary();
      return { kind: 'unary', op: token.value as UnaryOperator, operand, start: token.start };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.advance();

    if (token.type === 'number') return { kind: 'number', value: token.value, start: token.start };
    if (token.type === 'string') return { kind: 'string', value: token.value, start: token.start };

    if (token.type === 'ident') {
      if (token.value === 'true') return { kind: 'boolean', value: true, start: token.start };
      if (token.value === 'false') return { kind: 'boolean', value: false, start: token.start };
      if (token.value === 'null') return { kind: 'null', start: token.start };
      if (!this.refs.includes(token.value)) this.refs.push(token.value);
      return { kind: 'ident', name: token.value, start: token.start };
    }

    if (token.type === 'operator' && token.value === '(') {
      const inner = this.parseOr();
      this.expectOperator(')');
      return inner;
    }

    this.unexpected(token, 'se esperaba un valor, una referencia o "("');
  }
}

/** Parsea una expresión y devuelve su AST junto con las referencias usadas. */
export function parseExpression(expr: string): { ast: Node; refs: string[] } {
  const lexer = new Lexer(expr);
  const parser = new Parser(lexer.tokenize(), expr);
  const ast = parser.parse();
  return { ast, refs: parser.refs };
}

/** Identificadores únicos referenciados por la expresión, en orden de aparición. */
export function collectRefs(expr: string): string[] {
  return parseExpression(expr).refs;
}

function truthy(value: Value): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  return value.length > 0;
}

function toNumber(value: Value, op: string, position: number): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  }
  exprError(
    `el operador "${op}" requiere números en la posición ${position}`,
    position,
    `Se recibió ${value === null ? 'null' : JSON.stringify(value)}. Usá un número o una referencia numérica.`,
  );
}

function numericOrUndefined(value: Value): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function compareEquality(op: '==' | '!=', left: Value, right: Value): boolean {
  let a = left;
  let b = right;
  if (typeof a === 'number' && typeof b === 'string') {
    const n = numericOrUndefined(b);
    if (n !== undefined) b = n;
  } else if (typeof a === 'string' && typeof b === 'number') {
    const n = numericOrUndefined(a);
    if (n !== undefined) a = n;
  }
  return op === '==' ? a === b : a !== b;
}

function compareOrder(op: '>' | '>=' | '<' | '<=', left: Value, right: Value, position: number): boolean {
  let a = left;
  let b = right;
  if (typeof a === 'number' && typeof b === 'string') {
    const n = numericOrUndefined(b);
    if (n !== undefined) b = n;
  } else if (typeof a === 'string' && typeof b === 'number') {
    const n = numericOrUndefined(a);
    if (n !== undefined) a = n;
  }

  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) {
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
    }
  }

  if (typeof a === 'string' && typeof b === 'string') {
    switch (op) {
      case '>':
        return a > b;
      case '>=':
        return a >= b;
      case '<':
        return a < b;
      case '<=':
        return a <= b;
    }
  }

  exprError(
    `comparación inválida con "${op}" en la posición ${position}`,
    position,
    'Compará números con números o strings con strings; no mezcles booleanos/null con orden.',
  );
}

function resolveIdentifier(name: string, scope: ExprScope, position: number): Value {
  if (Object.prototype.hasOwnProperty.call(scope, name)) {
    return scope[name]!;
  }

  const segments = name.split('.');
  let current: unknown = scope;

  for (const segment of segments) {
    if (current !== null && typeof current === 'object') {
      const container = current as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(container, segment)) {
        current = container[segment];
        continue;
      }
    }
    unknownReference(name, current, position);
  }

  return current as Value;
}

function unknownReference(name: string, level: unknown, position: number): never {
  const keys = availableKeys(level);
  exprError(
    `referencia desconocida: "${name}"`,
    position,
    `Posición ${position}. Claves disponibles: ${formatKeys(keys)}.`,
  );
}

function evaluateNode(node: Node, scope: ExprScope): Value {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'ident':
      return resolveIdentifier(node.name, scope, node.start);
    case 'unary': {
      const operand = evaluateNode(node.operand, scope);
      if (node.op === '!') return !truthy(operand);
      return -toNumber(operand, '-', node.start);
    }
    case 'binary':
      break;
  }

  const { op, left: leftNode, right: rightNode, start } = node;

  if (op === '&&') {
    const left = evaluateNode(leftNode, scope);
    if (!truthy(left)) return false;
    return truthy(evaluateNode(rightNode, scope));
  }
  if (op === '||') {
    const left = evaluateNode(leftNode, scope);
    if (truthy(left)) return true;
    return truthy(evaluateNode(rightNode, scope));
  }

  const left = evaluateNode(leftNode, scope);
  const right = evaluateNode(rightNode, scope);

  switch (op) {
    case '==':
    case '!=':
      return compareEquality(op, left, right);
    case '>':
    case '>=':
    case '<':
    case '<=':
      return compareOrder(op, left, right, start);
    case '+':
      return toNumber(left, op, start) + toNumber(right, op, start);
    case '-':
      return toNumber(left, op, start) - toNumber(right, op, start);
    case '*':
      return toNumber(left, op, start) * toNumber(right, op, start);
    case '/': {
      const divisor = toNumber(right, op, start);
      if (divisor === 0) {
        exprError(
          `división por cero en la posición ${start}`,
          start,
          'Asegurate de que el divisor no sea 0, por ejemplo con "denominador > 0 && numerador / denominador".',
        );
      }
      return toNumber(left, op, start) / divisor;
    }
    case '%': {
      const divisor = toNumber(right, op, start);
      if (divisor === 0) {
        exprError(
          `módulo por cero en la posición ${start}`,
          start,
          'Asegurate de que el divisor no sea 0 antes de usar "%".',
        );
      }
      return toNumber(left, op, start) % divisor;
    }
    default: {
      const never: never = op;
      return never;
    }
  }
}

/** Evalúa una expresión contra un scope plano de valores primitivos. */
export function evaluateExpression(expr: string, scope: ExprScope): number | string | boolean {
  const { ast } = parseExpression(expr);
  const result = evaluateNode(ast, scope);
  if (result === null) {
    return false;
  }
  if (typeof result === 'object') {
    exprError('resultado inválido', 0, 'La expresión debe devolver un número, string o booleano.');
  }
  return result;
}
