#!/usr/bin/env node
/** Valida cada receta JSON staged con `m1 recipe validate`. */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const files = process.argv.slice(2);
const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cli = join(process.cwd(), 'src', 'cli', 'index.ts');

for (const file of files) {
  console.log(`recipe validate: ${file}`);
  execFileSync(process.execPath, [tsx, cli, 'recipe', 'validate', file], { stdio: 'inherit' });
}
