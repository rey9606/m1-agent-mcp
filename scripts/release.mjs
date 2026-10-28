#!/usr/bin/env node
/**
 * Prepara un release: sube la versión, commitea y crea un tag **anotado**.
 *
 * Existe porque `npm version` no sirve en este repo:
 *   - su mensaje por defecto (`v0.1.6`) no pasa el hook commit-msg (pide 8+
 *     caracteres de descripción);
 *   - crea el tag liviano, y `git push --follow-tags` sólo empuja anotados.
 *
 * Uso:
 *   pnpm release patch        # 0.1.5 -> 0.1.6
 *   pnpm release minor        # 0.1.5 -> 0.2.0
 *   pnpm release major        # 0.1.5 -> 1.0.0
 *   pnpm release 0.2.3        # versión explícita
 *   pnpm release patch --dry-run
 *
 * No pushea: imprime el comando exacto para que revises antes de disparar el
 * workflow de publicación (`.github/workflows/publish.yml`).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
const bump = args[0];

if (!bump || args.length > 1) {
  console.error('uso: pnpm release <patch|minor|major|X.Y.Z> [--dry-run]');
  process.exit(2);
}

const git = (argv) => execFileSync('git', argv, { encoding: 'utf8' }).trim();

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const next = computeVersion(current, bump);
const tag = `v${next}`;
const message = `chore(release): publicar la version ${next}`;

if (git(['status', '--porcelain']) !== '') {
  console.error('✗ el árbol no está limpio: commiteá o stasheá antes de releasear');
  process.exit(1);
}

const branch = git(['branch', '--show-current']);
if (branch !== 'main') {
  console.error(`✗ estás en "${branch}": los releases salen de main`);
  process.exit(1);
}

if (tags().includes(tag)) {
  console.error(`✗ el tag ${tag} ya existe`);
  process.exit(1);
}

if (published(next)) {
  console.error(`✗ m1-agent@${next} ya está publicado en npm: subí la versión`);
  process.exit(1);
}

console.log(`  ${current} -> ${next}  (tag anotado ${tag})`);
if (dryRun) {
  console.log('  dry-run: no se tocó nada');
  process.exit(0);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = next;
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

git(['add', 'package.json']);
git(['commit', '-m', message]);
git(['tag', '-a', tag, '-m', `m1-agent ${next}`]);

console.log(`\n✓ commit y tag ${tag} creados. Para publicar:\n`);
console.log('  git push origin main --follow-tags\n');

function computeVersion(currentVersion, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;

  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(currentVersion);
  if (!match) {
    console.error(`✗ versión actual inesperada: ${currentVersion}`);
    process.exit(1);
  }

  const [major, minor, patch] = match.slice(1).map(Number);
  if (spec === 'major') return `${major + 1}.0.0`;
  if (spec === 'minor') return `${major}.${minor + 1}.0`;
  if (spec === 'patch') return `${major}.${minor}.${patch + 1}`;

  console.error(`✗ incremento desconocido: ${spec}`);
  process.exit(2);
}

function tags() {
  return git(['tag', '--list']).split(/\r?\n/).filter(Boolean);
}

function published(version) {
  // En Windows `npm` es un .cmd: execFileSync no resuelve el shim solo.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    execFileSync(npm, ['view', `m1-agent@${version}`, 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}