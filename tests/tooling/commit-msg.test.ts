import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-commit-msg.mjs');

const tempDirs: string[] = [];

/** Repo temporal aislado: el script sólo necesita un archivo de mensaje. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-commit-msg-'));
  tempDirs.push(dir);
  return dir;
}

function runMessage(dir: string, message: string) {
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, message);
  return spawnSync(process.execPath, [SCRIPT, file], { cwd: dir, encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-commit-msg: mensajes válidos', () => {
  it.each([
    ['feat: agregar comando doctor'],
    ['fix(cli): corregir salida de error'],
    ['chore!: romper compatibilidad de config'],
    ['revert: deshacer cambio de proveedor'],
    ["Merge branch 'main' into feature"],
    ['fixup! feat: agregar comando doctor'],
    ['squash! fix(cli): corregir salida'],
  ])('sale 0 con %j', (message) => {
    const dir = makeRepo();

    const result = runMessage(dir, message);

    expect(result.status, result.stderr).toBe(0);
  });

  it('ignora líneas comentadas del editor', () => {
    const dir = makeRepo();
    const message = 'feat(core): agregar motor de decisión\n\n# Please enter the commit message\n';

    const result = runMessage(dir, message);

    expect(result.status, result.stderr).toBe(0);
  });
});

describe('check-commit-msg: mensajes inválidos', () => {
  it.each([
    ['update stuff'],
    ['feat:'],
    ['feat: corto'],
    ['Feat: mayúscula no permitida'],
  ])('sale 1 con %j', (message) => {
    const dir = makeRepo();

    const result = runMessage(dir, message);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('commit-msg: mensaje inválido');
  });

  it('sale 1 con un header de más de 100 caracteres', () => {
    const dir = makeRepo();
    const message = `feat: ${'a'.repeat(100)}`;

    const result = runMessage(dir, message);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('máximo 100');
  });

  it('sale 1 si el archivo de mensaje no existe', () => {
    const dir = makeRepo();

    const result = spawnSync(process.execPath, [SCRIPT, join(dir, 'no-existe')], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no se pudo leer');
  });

  it('sale 1 sin argumento de archivo', () => {
    const dir = makeRepo();

    const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('falta la ruta');
  });
});
