#!/usr/bin/env node
/**
 * Valida el header del mensaje de commit (Conventional Commits).
 *
 * Uso: node scripts/check-commit-msg.mjs <ruta-al-archivo-de-mensaje>
 */
import { readFileSync } from 'node:fs';

const HEADER_RE = /^(feat|fix|test|docs|refactor|perf|build|ci|chore|revert)(\([a-z0-9._-]+\))?!?: .{8,}$/;
const MAX_HEADER = 100;
const ALLOWED_PASSTHROUGH = [/^Merge /, /^Revert /, /^fixup! /, /^squash! /];

const messagePath = process.argv[2];
if (!messagePath) {
  console.error('commit-msg: falta la ruta del archivo de mensaje');
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(messagePath, 'utf8');
} catch {
  console.error(`commit-msg: no se pudo leer el mensaje en ${messagePath}`);
  process.exit(1);
}

// Git agrega comentarios (#) en el editor; ignorarlos para evaluar el mensaje real.
const lines = raw.split(/\r?\n/).filter((line) => !line.startsWith('#'));
const header = (lines.find((line) => line.trim() !== '') ?? '').trim();

const fail = (reason) => {
  console.error('\ncommit-msg: mensaje inválido\n');
  console.error(`  ✗ ${reason}`);
  console.error('\nFormato: <tipo>(<scope opcional>)!: <descripción de 8+ caracteres>');
  console.error('Tipos: feat, fix, test, docs, refactor, perf, build, ci, chore, revert');
  console.error('Ejemplo: feat(cli): agregar comando doctor');
  console.error(`Header máximo: ${MAX_HEADER} caracteres\n`);
  process.exit(1);
};

if (header === '') fail('el mensaje está vacío');
if (header.length > MAX_HEADER) {
  fail(`el header tiene ${header.length} caracteres (máximo ${MAX_HEADER})`);
}
if (ALLOWED_PASSTHROUGH.some((re) => re.test(header))) {
  process.exit(0);
}
if (!HEADER_RE.test(header)) {
  fail('no cumple Conventional Commits (¿tipo válido, dos puntos y espacio, descripción de 8+ caracteres?)');
}

process.exit(0);
