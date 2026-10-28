#!/usr/bin/env node
/**
 * Valida cada workflow JSON staged con `m1 workflow validate <ruta>`.
 *
 * La ruta se pasa tal cual: es el escape hatch documentado para CI, ya que los
 * workflows de usuario se invocan por nombre pero los de `examples/` viven en el
 * repo y no están en el registry global.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const files = process.argv.slice(2);
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = join(process.cwd(), 'src', 'cli', 'index.ts');

for (const file of files) {
  console.log(`workflow validate: ${file}`);
  execFileSync(process.execPath, [tsx, cli, 'workflow', 'validate', file], { stdio: 'inherit' });
}