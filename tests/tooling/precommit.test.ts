import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const GUARDS = join(REPO_ROOT, 'scripts', 'precommit-guards.mjs');
const VALIDATE_RECIPES = join(REPO_ROOT, 'scripts', 'validate-recipes.mjs');

const tempDirs: string[] = [];

interface TempRepo {
  dir: string;
  git: (...args: string[]) => string;
}

/** Crea un repo git temporal aislado (sin tocar el repo real). */
function makeRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), 'm1-precommit-'));
  tempDirs.push(dir);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.email', 'precommit-test@example.com');
  git('config', 'user.name', 'Precommit Test');
  git('config', 'commit.gpgsign', 'false');
  return { dir, git };
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-recipe-'));
  tempDirs.push(dir);
  return dir;
}

function write(repo: TempRepo, relPath: string, content: string | Buffer): string {
  const absPath = join(repo.dir, relPath);
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  return absPath;
}

function stage(repo: TempRepo, relPath: string, content: string | Buffer = ''): void {
  write(repo, relPath, content);
  repo.git('add', '--', relPath);
}

/** Ejecuta el guard con cwd = repo temporal (como lo hace el hook). */
function runGuards(repoDir: string) {
  return spawnSync(process.execPath, [GUARDS], { cwd: repoDir, encoding: 'utf8' });
}

/** Ejecuta validate-recipes con cwd = repo real (resuelve tsx y el CLI desde ahí). */
function runValidate(...files: string[]) {
  return spawnSync(process.execPath, [VALIDATE_RECIPES, ...files], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });
}

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// precommit-guards.mjs: bloqueos
// ---------------------------------------------------------------------------

describe('precommit-guards: bloquea material sensible', () => {
  it.each([
    ['.env', 'FOO=bar\n'],
    ['credentials.json', '{"password":"x"}\n'],
    ['certs/server.pem', '-----BEGIN CERTIFICATE-----\n'],
    ['keys/private.key', '-----BEGIN PRIVATE KEY-----\n'],
  ])('sale 1 al stagear %s', (relPath, content) => {
    const repo = makeRepo();
    stage(repo, relPath, content);

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(relPath);
  });

  it('sale 1 con un archivo de más de 1 MiB', () => {
    const repo = makeRepo();
    stage(repo, 'assets/big.bin', Buffer.alloc(1024 * 1024 + 1, 0));

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('assets/big.bin');
    expect(result.stderr).toContain('máximo 1 MiB');
  });

  it('sale 1 con CLOUDFLARE_API_TOKEN pegado en el código', () => {
    const repo = makeRepo();
    stage(repo, 'src/config.ts', `export const token = 'CLOUDFLARE_API_TOKEN=${TOKEN}';\n`);

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('src/config.ts');
    expect(result.stderr).toContain('token real');
  });

  it('sale 1 con una clave privada dentro de un archivo de texto', () => {
    const repo = makeRepo();
    // Cuerpo base64 generado en runtime: el fixture no contiene una clave literal.
    const keyBody = 'MIIB'.repeat(20);
    stage(repo, 'notes.md', `# Notas\n\n-----BEGIN PRIVATE KEY-----\n${keyBody}\n`);

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('clave privada');
  });

  it('no marca un header de clave sin cuerpo base64 (fixture)', () => {
    const repo = makeRepo();
    stage(repo, 'notes.md', '# Notas\n\n-----BEGIN PRIVATE KEY-----\nMIIB...\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(0);
  });

  it('sale 1 si el secreto está en el índice pero ya no en el working tree', () => {
    const repo = makeRepo();
    stage(repo, 'src/config.ts', `export const token = 'CLOUDFLARE_API_TOKEN=${TOKEN}';\n`);
    // El commit publica el índice: limpiar el archivo en disco no debe saltear la guarda.
    write(repo, 'src/config.ts', 'export const token = undefined;\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('src/config.ts');
  });

  it('sale 1 si el archivo grande está en el índice pero se achicó en disco', () => {
    const repo = makeRepo();
    stage(repo, 'assets/big.bin', Buffer.alloc(1024 * 1024 + 1, 0));
    write(repo, 'assets/big.bin', Buffer.alloc(10, 0));

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('assets/big.bin');
  });
});

// ---------------------------------------------------------------------------
// precommit-guards.mjs: casos permitidos
// ---------------------------------------------------------------------------

describe('precommit-guards: permite archivos normales', () => {
  it('sale 0 con ts/md/json normales y .env.example', () => {
    const repo = makeRepo();
    stage(repo, 'src/index.ts', 'export const answer = 42;\n');
    stage(repo, 'README.md', '# Proyecto\n\nSin secretos.\n');
    stage(repo, 'package.json', '{"name":"tmp"}\n');
    stage(repo, '.env.example', 'FOO=\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('4 archivo(s) staged');
  });

  it('sale 0 con un token corto (placeholder) en un archivo de texto', () => {
    const repo = makeRepo();
    stage(repo, '.env.example', 'CLOUDFLARE_API_TOKEN=changeme\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(0);
  });

  it('ignora archivos borrados (diff-filter=ACMR)', () => {
    const repo = makeRepo();
    stage(repo, 'obsolete.ts', 'export const old = 1;\n');
    repo.git('commit', '--quiet', '-m', 'base');
    repo.git('rm', '--quiet', 'obsolete.ts');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('0 archivo(s) staged');
  });

  it('no rompe con un archivo staged pero inexistente en el working tree', () => {
    const repo = makeRepo();
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo.dir,
      input: 'export const ghost = 1;\n',
      encoding: 'utf8',
    }).trim();
    repo.git('update-index', '--add', '--cacheinfo', `100644,${blob},ghost.ts`);
    // Sanity check: el archivo está en el índice pero no en disco.
    expect(repo.git('diff', '--cached', '--name-only')).toContain('ghost.ts');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// precommit-guards.mjs: higiene (conflictos, JSON, lockfiles)
// ---------------------------------------------------------------------------

describe('precommit-guards: higiene del índice', () => {
  it('sale 1 con marcadores de conflicto sin resolver', () => {
    const repo = makeRepo();
    stage(
      repo,
      'src/conflict.ts',
      [
        'export const value = 1;',
        '<<<<<<< HEAD',
        'const answer = 1;',
        '=======',
        'const answer = 2;',
        '>>>>>>> feature',
        '',
      ].join('\n'),
    );

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('src/conflict.ts');
    expect(result.stderr).toContain('marcadores de conflicto');
  });

  it('detecta conflictos desde el índice aunque el working tree esté resuelto', () => {
    const repo = makeRepo();
    stage(
      repo,
      'notes.md',
      ['<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> rama', ''].join('\n'),
    );
    write(repo, 'notes.md', '# resuelto\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('marcadores de conflicto');
  });

  it('sale 1 con un marcador de inicio aislado', () => {
    const repo = makeRepo();
    stage(repo, 'src/conflict.ts', '<<<<<<< HEAD\nexport const value = 1;\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('marcadores de conflicto');
  });

  it('no marca un separador `=======` suelto (heading Setext)', () => {
    const repo = makeRepo();
    stage(repo, 'docs/heading.md', 'Título\n=======\n\nSin conflicto.\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(0);
  });

  it('sale 1 con JSON inválido', () => {
    const repo = makeRepo();
    stage(repo, 'config/broken.json', '{ "name": "tmp", ');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('config/broken.json');
    expect(result.stderr).toContain('JSON inválido');
  });

  it('detecta JSON inválido desde el índice aunque el working tree esté corregido', () => {
    const repo = makeRepo();
    stage(repo, 'config/broken.json', '{ "name": ');
    write(repo, 'config/broken.json', '{"name":"ok"}\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('JSON inválido');
  });

  it.each(['package-lock.json', 'yarn.lock'])('sale 1 al stagear %s', (relPath) => {
    const repo = makeRepo();
    stage(repo, relPath, '{}\n');

    const result = runGuards(repo.dir);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(relPath);
    expect(result.stderr).toContain('pnpm');
  });
});

// ---------------------------------------------------------------------------
// validate-recipes.mjs
// ---------------------------------------------------------------------------

describe('validate-recipes', () => {
  it('sale 0 con una receta válida en un directorio temporal', () => {
    const dir = makeTempDir();
    const recipePath = join(dir, 'valid.json');
    // Copia literal de una receta de ejemplo (válida según tests/examples.test.ts).
    writeFileSync(recipePath, readFileSync(join(REPO_ROOT, 'examples', 'copy-checker.json')));

    const result = runValidate(recipePath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('recipe validate');
  }, 60_000);

  it('sale != 0 con JSON inválido', () => {
    const dir = makeTempDir();
    const recipePath = join(dir, 'broken.json');
    writeFileSync(recipePath, '{ "schema": "m1agent/recipe@1", ');

    const result = runValidate(recipePath);

    expect(result.status).not.toBe(0);
  }, 60_000);

  it('sale != 0 con JSON válido que no cumple el schema', () => {
    const dir = makeTempDir();
    const recipePath = join(dir, 'invalid.json');
    writeFileSync(recipePath, JSON.stringify({ schema: 'm1agent/recipe@1' }));

    const result = runValidate(recipePath);

    expect(result.status).not.toBe(0);
  }, 60_000);
});
