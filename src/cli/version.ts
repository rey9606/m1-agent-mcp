import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Versión publicada por `m1 --version` y por `m1 guide --json`.
 *
 * Se lee del `package.json` en runtime en lugar de hardcodearse: antes había un
 * literal que quedaba desfasado en cada release y hacía que `npx m1-agent@latest
 * --version` mintiera. Se camina hacia arriba desde el módulo actual porque el
 * bundle puede vivir en `dist/cli/index.js` o en un `dist/chunk-*.js` compartido.
 */
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === 'm1-agent' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Sin package.json legible en este nivel: seguimos subiendo.
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return '0.0.0';
}

export const CLI_VERSION = readVersion();