#!/usr/bin/env node
/**
 * Guardas de pre-commit: se ejecutan sobre los archivos staged.
 *
 * - Bloquea `.env`, credenciales, claves privadas y lockfiles de otros gestores.
 * - Bloquea archivos > 1 MiB.
 * - Detecta tokens de Cloudflare pegados por accidente.
 * - Bloquea marcadores de conflicto sin resolver.
 * - Valida la sintaxis de los `.json` staged.
 *
 * Todo se lee del índice git (`git cat-file blob :path`), nunca del working
 * tree: el commit publica lo staged, así que escanear el disco permitiría
 * stagear un secreto y luego limpiarlo.
 */
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const MAX_BYTES = 1024 * 1024;
const TEXT_FILE = /\.(ts|mts|cts|js|mjs|cjs|json|md|ya?ml|sh|txt|example)$/i;
// `<<<<<<<` y `>>>>>>>` sólo aparecen en conflictos; `=======` suelto es un
// heading Setext válido en Markdown, así que no se marca por sí solo.
const CONFLICT_MARKERS = /^(?:<{7}|>{7})(?: .*)?$/m;
const errors = [];

const gitIndex = (args) => execFileSync('git', args, { maxBuffer: 16 * 1024 * 1024 });

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .filter(Boolean);

const isEnvFile = (name) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example');

for (const file of staged) {
  const name = basename(file).toLowerCase();

  if (isEnvFile(name)) {
    errors.push(`${file}: no se commitean archivos .env (solo .env.example)`);
    continue;
  }
  if (name === 'credentials.json') {
    errors.push(`${file}: no se commitean credenciales`);
    continue;
  }
  if (name === 'package-lock.json' || name === 'yarn.lock') {
    errors.push(`${file}: este repo usa pnpm (commiteá pnpm-lock.yaml)`);
    continue;
  }
  if (/\.(pem|key|p12|pfx)$/i.test(name)) {
    errors.push(`${file}: clave privada o certificado`);
    continue;
  }

  let size;
  try {
    size = Number(gitIndex(['cat-file', '-s', `:${file}`]).toString('utf8').trim());
  } catch {
    // Entrada presente en el diff pero no resoluble en el índice: no bloquear por esto.
    continue;
  }
  if (!Number.isFinite(size)) continue;
  if (size > MAX_BYTES) {
    errors.push(`${file}: ${(size / 1024 / 1024).toFixed(1)} MiB (máximo 1 MiB)`);
    continue;
  }

  if (!TEXT_FILE.test(name)) continue;
  const text = gitIndex(['cat-file', 'blob', `:${file}`]).toString('utf8');

  if (name.endsWith('.json')) {
    try {
      // Windows suele agregar BOM al guardar: no es un error de sintaxis JSON.
      JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${file}: JSON inválido (${detail})`);
    }
  }

  // Un `=======` suelto es un heading Setext válido en Markdown; no se marca solo.
  if (CONFLICT_MARKERS.test(text)) {
    errors.push(`${file}: tiene marcadores de conflicto sin resolver`);
  }

  // Exige cuerpo base64 plausible (>=40 chars) para no marcar fixtures de test.
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,200}?[A-Za-z0-9+/]{40,}/.test(text)) {
    errors.push(`${file}: contiene una clave privada`);
  }
  if (/(CLOUDFLARE_API_TOKEN|TYPESAFE_API_KEY|LOCAL_API_KEY|OPENROUTER_KEY)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/.test(text)) {
    errors.push(`${file}: parece contener un token real`);
  }
}

if (errors.length > 0) {
  console.error('\npre-commit: revisá estos archivos antes de commitear:\n');
  for (const error of errors) console.error(`  ✗ ${error}`);
  console.error('');
  process.exit(1);
}

console.log(`pre-commit: ${staged.length} archivo(s) staged sin secretos ni binarios grandes`);
