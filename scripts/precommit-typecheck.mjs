#!/usr/bin/env node
/**
 * Typecheck condicional del pre-commit.
 *
 * `tsc` tarda varios segundos y un commit de docs no puede pagarlo. Sólo
 * corremos el typecheck si hay archivos TypeScript staged.
 */
import { execFileSync, spawnSync } from 'node:child_process';

const stagedTs = execFileSync(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '--', '*.ts', '*.mts', '*.cts'],
  { encoding: 'utf8' },
)
  .split(/\r?\n/)
  .filter(Boolean);

if (stagedTs.length === 0) {
  console.log('typecheck: skip (sin .ts staged)');
  process.exit(0);
}

const isWindows = process.platform === 'win32';
const result = spawnSync(isWindows ? 'pnpm.cmd' : 'pnpm', ['run', 'typecheck'], {
  stdio: 'inherit',
  // Los .cmd de Windows sólo se pueden lanzar a través de un shell.
  shell: isWindows,
});
process.exit(result.status ?? 1);
