#!/usr/bin/env node
/**
 * Pre-push: auditoría de dependencias (si cambió el lockfile) + suite completa.
 *
 * - `pnpm audit --audit-level=high` requiere red. Sólo se ejecuta cuando los
 *   commits no pusheados tocaron `pnpm-lock.yaml`.
 * - `pnpm test` completo es la red de seguridad: los hooks de pre-commit usan
 *   `vitest related`, que no selecciona los tests e2e.
 */
import { execFileSync, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
// Los .cmd de Windows sólo se pueden lanzar a través de un shell.
const spawnPnpm = (args) => spawnSync(pnpm, args, { stdio: 'inherit', shell: isWindows });

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const fileList = (range) =>
  git(['diff', '--name-only', range])
    .split(/\r?\n/)
    .filter(Boolean);

let upstream = null;
try {
  upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
} catch {
  // Sin upstream: no es un error, sólo saltamos el audit.
}

let changedFiles = [];
if (upstream) {
  try {
    changedFiles = fileList(`${upstream}..HEAD`);
  } catch {
    // Upstream configurado pero no resoluble (p. ej. ref borrada): fallback.
    try {
      changedFiles = fileList('HEAD~10..HEAD');
    } catch {
      changedFiles = [];
    }
  }
}

if (!upstream) {
  console.log('pre-push: sin upstream configurado, skip audit');
} else if (changedFiles.includes('pnpm-lock.yaml')) {
  console.log('pre-push: pnpm-lock.yaml cambió, corriendo pnpm audit --audit-level=high');
  const audit = spawnPnpm(['audit', '--audit-level=high']);
  if (audit.status !== 0) {
    console.error('\npre-push: pnpm audit encontró vulnerabilidades de severidad high o superior.');
    console.error('Revisá el reporte, actualizá las dependencias y volvé a intentar.');
    console.error('Nota: audit requiere conexión a red; si falló por red, reintentá el push.\n');
    process.exit(audit.status ?? 1);
  }
} else {
  console.log('pre-push: pnpm-lock.yaml sin cambios, skip audit');
}

const tests = spawnPnpm(['test']);
process.exit(tests.status ?? 1);
