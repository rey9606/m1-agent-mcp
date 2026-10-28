# Tests y flujo pre-commit

Este documento describe cómo está armada la suite, qué corre cada comando y qué valida el hook de pre-commit. La fuente de verdad es `package.json`, `vitest.config.ts`, `.husky/pre-commit` y los scripts de `scripts/`.

## 1. Pirámide real del repo

No hay capas separadas por configuración: `vitest.config.ts:6` incluye `tests/**/*.test.ts`, así que **todos** los tests conviven bajo el mismo runner. La separación es por directorio y por archivo, no por comando.

| Capa | Archivos | Qué ejercita | Red |
| --- | --- | --- | --- |
| Unitarios | `tests/expr.test.ts`, `tests/template.test.ts`, `tests/normalize.test.ts`, `tests/intake.test.ts`, `tests/providers.test.ts`, `tests/config.test.ts`, `tests/engine.test.ts` | Importan módulos de `src/` y los prueban en el mismo proceso | Ninguna |
| Contrato de ejemplos | `tests/examples.test.ts` | Valida las recetas de `examples/`, sus invariantes semánticas, los requests del dry-run y los veredictos con `fixtures/mock/answers.json` | Ninguna |
| Tooling | `tests/tooling/precommit.test.ts` | Ejecuta `scripts/precommit-guards.mjs` en repos git temporales y `scripts/validate-recipes.mjs` contra recetas temporales | Ninguna (git local) |
| E2E de CLI | `tests/cli.test.ts` | Spawnea la CLI real (`node node_modules/tsx/dist/cli.mjs src/cli/index.ts`) contra configs temporales con provider `mock` | Ninguna |
| Integración HTTP | `tests/integration/systemone.test.ts` | Corre la CLI completa contra un `http.Server` local en `127.0.0.1` con el provider `systemone` real | Loopback |
| Live opt-in | `tests/integration/cloudflare.live.test.ts` | Llama a Cloudflare Workers AI de verdad | Internet + credenciales |

En orden de costo:

```text
live (Cloudflare real, opt-in)
  integración HTTP (servidor local, provider systemone)
    e2e de CLI (proceso real, provider mock)
      tooling (guardas y validación de recetas)
        unitarios y contrato de ejemplos (in-process)
```

Detalles que importan:

- `tests/cli.test.ts:9-12` lo deja explícito: se ejecuta la CLI como proceso real, con `tsx`, y nunca se toca la red (todas las configs usan `mock`).
- `tests/integration/systemone.test.ts:110-112` levanta el servidor en el puerto 0 (efímero) sobre `127.0.0.1`; no hay red externa ni mocks del transporte.
- El test live está envuelto en `describe.skipIf(!LIVE)` (`tests/integration/cloudflare.live.test.ts:13-15`): sin `M1_LIVE=1` no ejecuta nada y el archivo se reporta como skipped.
- `vitest.config.ts:7` fija `testTimeout` en 10 s. Los tests que necesitan más lo pisan en el propio `it` (el live usa 45 s, `cloudflare.live.test.ts:61`).

## 2. Comandos

Todos los comandos se ejecutan desde la raíz del repo, con dependencias instaladas (`pnpm install`).

| Comando | Qué corre | Necesita |
| --- | --- | --- |
| `pnpm test` | `vitest run`: toda la suite (`tests/**/*.test.ts`), incluidos e2e de CLI, tooling e integración local. El live queda skipped | Nada más que `node_modules` |
| `pnpm test:watch` | `vitest` en modo watch, misma cobertura que `pnpm test` | Nada |
| `pnpm test:changed` | `vitest run --changed`: tests afectados por cambios desde el último commit | Nada |
| `pnpm test:integration` | `vitest run tests/integration`: systemone local (corre) y live (skipped) | Loopback, sin credenciales |
| `pnpm test:live` | `node scripts/run-live-tests.mjs`, que corre `vitest run tests/integration/cloudflare.live.test.ts` con `M1_LIVE=1` | Red y credenciales de Cloudflare |
| `pnpm lint` | `eslint .` (flat config, type-aware en `src/`) | Nada |
| `pnpm typecheck` | `tsc --noEmit` sobre todo el proyecto | Nada |
| `pnpm build` | `tsup` a `dist/` (ESM + sourcemaps) | Nada |
| `pnpm precommit` | `node scripts/precommit-guards.mjs` (las guardas, sin lint-staged ni typecheck) | Archivos staged |

Notas:

- `pnpm test` no necesita `.env`: los tests usan provider `mock`, un servidor local o el provider live (que se skipea).
- `pnpm build` y `pnpm test` son independientes: build no corre tests y typecheck no compila nada.
- `pnpm test:changed` usa el grafo de git (`--changed`), no una lista de archivos. Dentro de lint-staged se usa `vitest related` con los staged, que es más preciso.

## 3. Correr un test puntual

```bash
# un archivo
pnpm exec vitest run tests/expr.test.ts

# un test por nombre (substring del título)
pnpm exec vitest run tests/cli.test.ts -t "dry-run"

# integración local
pnpm exec vitest run tests/integration/systemone.test.ts

# sólo los tests afectados por un archivo fuente
pnpm exec vitest related --run src/intake/images.ts
```

`vitest related` arma el grafo de imports estáticos y corre los tests que importan el archivo indicado (directa o transitivamente). Sirve para saber qué rompió un cambio sin correr todo.

Dos límites concretos de este repo:

- `tests/cli.test.ts` no importa nada de `src/`: spawnea un proceso. Por eso `vitest related` **nunca** lo selecciona, aunque cambies `src/cli/`. Lo mismo pasa con `tests/integration/systemone.test.ts` y `tests/tooling/precommit.test.ts`.
- lint-staged sólo aplica `vitest related` a archivos `*.{ts,mts,cts}` (`package.json:27`). Un cambio en `scripts/*.mjs`, `docs/*.md` o `.husky/*` no dispara tests en el hook.

Para esos casos, corré el archivo a mano o la suite completa antes de commitear.

## 4. Live tests (Cloudflare)

El test live pega contra Workers AI con el modelo `@cf/cloudflare/clef-flash` y verifica que la respuesta traiga `noul` y `score` con el contrato esperado (`tests/integration/cloudflare.live.test.ts:16-51`). Hace una sola llamada, con dos preguntas y un `AbortSignal` de 30 s (`:40`).

Preparación:

1. Crear `.env` en la raíz del repo. `loadDotEnv` lee `.env` del working directory y **no pisa** variables ya definidas (`src/config/config.ts:16-25`).
2. Definir las credenciales:

   ```dotenv
   CLOUDFLARE_ACCOUNT_ID=<account-id>
   CLOUDFLARE_API_TOKEN=<api-token>
   ```

3. Opcional: `pnpm m1 auth set cf --env CLOUDFLARE_API_TOKEN` guarda sólo el nombre de la variable en `~/.config/m1-agent/credentials.json` (`src/cli/commands/auth.ts:16-26`). No hace falta para `kind: cloudflare`: `resolveSecrets` usa `CLOUDFLARE_API_TOKEN` por defecto (`src/config/credentials.ts:63-66`). Sirve para otros providers o para fijar una variable distinta.

   Alternativa: `pnpm m1 auth set cf --token <api-token> --account-id <account-id>` guarda el token en `credentials.json`.

4. Correr:

   ```bash
   pnpm test:live
   ```

   El script setea `M1_LIVE=1` y ejecuta sólo `tests/integration/cloudflare.live.test.ts` (`scripts/run-live-tests.mjs:5-7`).

Para correrlo sin el script:

```bash
# bash
M1_LIVE=1 pnpm exec vitest run tests/integration/cloudflare.live.test.ts

# PowerShell
$env:M1_LIVE='1'; pnpm exec vitest run tests/integration/cloudflare.live.test.ts
```

### Cuota y error 429

La cuota gratuita de Workers AI es de 10.000 neurons por día. Cuando se agota, Cloudflare responde 429; el provider lo convierte en `E_PROVIDER` con el mensaje `Cloudflare 429` y el hint de rate limit (`src/providers/cloudflare.ts:104`, `:151-153`), y el test lo reescribe como:

```text
Cloudflare devolvió 429 (cuota diaria de neurons agotada). Reintentá cuando se renueve la cuota.
```

(`tests/integration/cloudflare.live.test.ts:52-58`). No es un fallo del código: esperá el reinicio de la cuota o usá una cuenta con cuota disponible. Tampoco lo arregla reintentar en el mismo día.

El live no corre en pre-commit, ni con `pnpm test`, ni con `pnpm test:integration`: sólo con `M1_LIVE=1`.

## 5. Pre-commit

`.husky/pre-commit` corre tres pasos en orden, con `set -e` (si uno falla, se corta el commit):

```sh
node scripts/precommit-guards.mjs
node_modules/.bin/lint-staged   # o `pnpm exec lint-staged` si no está instalado
node scripts/precommit-typecheck.mjs
```

### Paso 1: guardas de seguridad

`scripts/precommit-guards.mjs` trabaja sobre los archivos staged (`git diff --cached --name-only --diff-filter=ACMR`) y **lee el contenido del índice git** (`git cat-file blob :<path>`), no del working tree: el commit publica lo staged, así que escanear el disco permitiría stagear un secreto y limpiarlo después. Bloquea:

- `.env` y `.env.*`, salvo `.env.example`.
- Cualquier archivo cuyo basename sea `credentials.json`.
- Extensiones de clave o certificado: `.pem`, `.key`, `.p12`, `.pfx`.
- Archivos de más de 1 MiB.
- Bloques `-----BEGIN ... PRIVATE KEY-----` con cuerpo base64 plausible (≥ 40 caracteres), para no marcar fixtures de tests.
- Asignaciones de `CLOUDFLARE_API_TOKEN`, `TYPESAFE_API_KEY` o `LOCAL_API_KEY` con 20 caracteres o más, sólo en archivos de texto con extensiones `.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, `.json`, `.md`, `.yaml`, `.yml`, `.sh`, `.txt` o `.example`.
- Marcadores de conflicto sin resolver (`<<<<<<<`, `>>>>>>>`). `=======` solo no se marca porque es un heading Setext válido en Markdown.
- `package-lock.json` y `yarn.lock` (el repo usa `pnpm`).
- `.json` staged con sintaxis inválida.

Alcance real: los archivos borrados se ignoran (filtro `ACMR`), los binarios sólo se controlan por tamaño y las variables de otros providers (por ejemplo `SYSTEMONE_API_KEY`) no se detectan por nombre. Si no hay archivos staged, informa `0 archivo(s) staged` y sale 0.

### Paso 2: lint-staged

`lint-staged` aplica tres reglas (`package.json` → `lint-staged`):

| Patrón staged | Comando |
| --- | --- |
| `*.{ts,mts,cts}` | `eslint --fix` y después `vitest related --run --passWithNoTests` |
| `*.{ts,mts,cts,js,mjs,cjs,json,md,yml,yaml,sh,txt,example}` | `secretlint` (preset recomendado, ver `.secretlintrc.json`) |
| `examples/*.json` | `node scripts/validate-recipes.mjs` con esos archivos |

`secretlint` es la barrera principal de secretos; el regex de los guards queda como defensa en profundidad. Respeta `.gitignore`, así que un archivo forzado con `git add -f` podría quedar fuera de su alcance (los guards cubren `.env` y credenciales).

`validate-recipes.mjs` corre `m1 recipe validate` con `tsx` por cada receta recibida. Ojo: sólo se validan recetas que estén en `examples/`; una receta nueva en otra carpeta no se valida en el hook.

### Paso 3: typecheck condicional

`scripts/precommit-typecheck.mjs` corre `pnpm run typecheck` (`tsc --noEmit` sobre todo el proyecto) **sólo si hay `*.ts|*.mts|*.cts` staged**. Si no, imprime `typecheck: skip` y sale 0. El costo de `tsc` no se paga en commits de docs o JSON.

### Latencias medidas (Windows)

| Escenario | Tiempo |
| --- | --- |
| guards sin staged | ~0,1 s |
| typecheck skip | ~0,1 s |
| secretlint 1 `.md` | ~0,4 s |
| eslint type-aware 1 `.ts` | ~3,9 s |
| `vitest related` 1 `.ts` | ~1,1 s |
| `tsc --noEmit` | ~2,5 s |
| hook completo, sólo docs | ~1,2–2,1 s |
| hook completo con `.ts` | ~6–8,5 s |

El costo dominante en Windows es el arranque de Node (lint-staged, secretlint), no la lógica.

### commit-msg

`.husky/commit-msg` ejecuta `scripts/check-commit-msg.mjs`, que valida Conventional Commits:

```text
^(feat|fix|test|docs|refactor|perf|build|ci|chore|revert)(\([a-z0-9._-]+\))?!?: .{8,}$
```

Además exige header ≤ 100 caracteres y permite `Merge ...`, `Revert ...`, `fixup! ...` y `squash! ...` (rebase). Si el mensaje no cumple, el commit se aborta con el formato esperado.

### pre-push

`.husky/pre-push` ejecuta `scripts/prepush.mjs`:

1. Si entre los commits no pusheados cambió `pnpm-lock.yaml` (o, sin upstream, en `HEAD~10..HEAD`), corre `pnpm audit --audit-level=high`. Si encuentra vulnerabilidades altas o críticas, bloquea el push. Requiere red.
2. Siempre corre `pnpm test` completo. Es la red de seguridad de los tests que `vitest related` no selecciona (e2e e integración que spawnean procesos).

Sin upstream configurado no rompe: omite el audit y corre la suite.

### Lo que los hooks no hacen

- No corren `pnpm build`.
- No corren tests live (`M1_LIVE=1`).
- No validan recetas fuera de `examples/*.json`.
- No hay CI: los hooks locales son la única barrera.

### Saltearlo

`git commit --no-verify` omite el hook completo: guardas, tests relacionados y typecheck. Es sólo para una emergencia (por ejemplo, un hotfix mientras el hook está roto por una dependencia externa). Después de usarlo, verificá a mano (`pnpm test`, `pnpm typecheck`) y arreglá lo que faltaba en un commit siguiente. No lo uses para "ganar tiempo": el hook es la única barrera local que hay, porque el repo no tiene CI.

### Debuggear un fallo

| Falla en | Reproducir | Qué mirar |
| --- | --- | --- |
| Guardas | `node scripts/precommit-guards.mjs` (con los archivos ya staged) | El mensaje indica archivo y motivo. Si es un token de prueba, reemplazalo por un placeholder; si es un archivo grande, no debería versionarse |
| `recipe validate` | `pnpm m1 recipe validate examples/copy-checker.json` | Error de esquema o regla semántica; el mismo validador que usa el hook |
| Tests relacionados | `pnpm exec vitest related --run <archivos staged>` o `pnpm exec vitest run <test>` | Corré el test puntual con `-t` para aislar el caso |
| Typecheck | `pnpm typecheck` | Corregir el error de tipos; el hook no acepta warnings de `tsc` |

Otros casos:

- El hook no se ejecuta: verificá que husky esté instalado (`pnpm prepare`) y que `core.hooksPath` apunte a `.husky/_`. Los hooks son por clon, no viajan con el repo.
- lint-staged guarda temporalmente los cambios no staged mientras corre; si falla, los restaura. Volvé a correr el comando a mano para ver el error completo.
- Si el error es de red o de un servicio externo, no hay nada que arreglar en el commit: esperá y reintentá.

## 6. Convención de micro-commits

Un commit, un cambio lógico. No mezcles refactor, fix y documentación en el mismo commit; si el cambio necesita explicación, va en el cuerpo.

Formato del mensaje:

```text
tipo(scope): descripción breve en imperativo
```

- `tipo`: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `build`, `ci`, `chore` o `revert` (validado por `commit-msg`).
- `scope`: el área tocada, por ejemplo `cli`, `core`, `config`, `integration`, `examples`, `husky`, `api`.
- Descripción: minúscula, sin punto final, sin relleno, mínimo 8 caracteres.

Ejemplos reales del historial:

```text
test(integration): systemone por HTTP real y live test opt-in de Cloudflare
chore(tooling): pre-commit por capas con secretlint, commit-msg y lint type-aware
fix(config): cloudflare resuelve CLOUDFLARE_API_TOKEN por defecto
```

El formato ya no es una convención social: `.husky/commit-msg` lo valida. Para commits de emergencia que no encajan, usá `git commit --no-verify` y documentá el motivo en el cuerpo.

## 7. Cómo agregar un test

Elegí la capa según lo que querés probar:

| Qué probás | Dónde | Cómo |
| --- | --- | --- |
| Una función o módulo de `src/` | `tests/<área>.test.ts` | Importás el módulo y lo ejercitás en proceso |
| Una receta o el contrato de los ejemplos | `tests/examples.test.ts` | Cargás la receta, validás invariantes y, si hace falta, capturás requests del dry-run |
| Un script de tooling | `tests/tooling/*.test.ts` | `spawnSync` del script, con repo o directorio temporal |
| La CLI de punta a punta | `tests/cli.test.ts` | Usás el helper `cli()` con una config `mock` en un directorio temporal |
| Un provider por HTTP | `tests/integration/<provider>.test.ts` | Levantás un `http.Server` en el puerto 0 y corrés la CLI contra él |
| Un servicio externo real | `tests/integration/<provider>.live.test.ts` | Guard `M1_LIVE=1` y `describe.skipIf` |

Reglas prácticas:

- El archivo tiene que terminar en `.test.ts` y estar bajo `tests/`; `vitest.config.ts:6` lo levanta solo.
- Para tests de CLI, seguí el patrón de `tests/cli.test.ts:44-56`: `mkdtempSync` para el directorio temporal y limpieza en `afterEach`. Nunca uses el repo como cwd de escritura.
- Para imágenes, usá el PNG 1x1 en base64 (`tests/cli.test.ts:21-25`, `tests/examples.test.ts:25-27`) en lugar de binarios versionados.
- Para tests de integración, escuchá en `127.0.0.1` con puerto 0 y construí la `baseUrl` desde `server.address()` (`tests/integration/systemone.test.ts:110-112`).
- Para tests live, además del guard, agregá el archivo a `scripts/run-live-tests.mjs`: el script tiene hardcodeado el path de Cloudflare, así que un live nuevo no se ejecuta con `pnpm test:live` hasta que lo incluyas.
- Si el test tarda más de 10 s, pasale el timeout como tercer argumento del `it` (`it('...', async () => { ... }, 45_000)`).
- Descripciones en español, en la misma voz que el resto de la suite. Verificá códigos de salida explícitos en los e2e (0 `pass`, 1 `fail`, 2 `error`, 3 `needs_review`).

Antes de commitear:

```bash
pnpm exec vitest run tests/mi-test.test.ts
pnpm test
pnpm typecheck
```

## Discrepancias detectadas

Comportamientos reales que difieren de lo que sugieren los nombres, los scripts o la documentación previa:

1. `test:changed` usa `vitest run --changed` (cambios desde el último commit). Dentro de lint-staged se usa `vitest related`, que recibe los archivos staged y es más preciso. Los tests que spawnean procesos (`cli`, e2e, integración, tooling) no los selecciona ninguno de los dos; por eso `pre-push` corre la suite completa.
2. `tests/integration/cloudflare.live.test.ts:19-22` exige `apiKey` y `accountId` resueltos. `kind: cloudflare` toma `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` del entorno por defecto (`src/config/credentials.ts:63-69`), así que con `.env` alcanza.
3. La versión previa de `README.md` (línea 180 antes de este cambio) describía los tests como "unitarios en `tests/` (engine, expr, intake, normalize, providers, template)": omitía `config.test.ts`, `cli.test.ts`, `examples.test.ts`, `tests/integration/` y `tests/tooling/`, aunque `pnpm test` corre todo eso. Quedó corregido en el README actual.
4. `scripts/run-live-tests.mjs:5` hardcodea `tests/integration/cloudflare.live.test.ts`: cualquier live nuevo queda fuera de `pnpm test:live` salvo que se edite el script.
5. `tests/cli.test.ts` y los tests de integración no importan módulos de `src/` (spawnean la CLI), así que `vitest related` nunca los selecciona; y lint-staged sólo se aplica a `*.{ts,mts,cts}` (`package.json:27`), por lo que cambios en `scripts/*.mjs` o `.husky/*` no disparan tests en el hook.
6. `scripts/precommit-guards.mjs:51` limita el escaneo de secretos a ciertas extensiones de texto y `:56` sólo reconoce `CLOUDFLARE_API_TOKEN`, `TYPESAFE_API_KEY` y `LOCAL_API_KEY`: un token de `SYSTEMONE_API_KEY` en un `.ts` no se detecta, y un token en una extensión fuera de la lista tampoco.
