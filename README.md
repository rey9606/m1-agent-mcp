# m1-agent

CLI y motor de flujo para **agentes de decisión** definidos en JSON. No es un LLM: interpreta una receta, arma las preguntas y delega el juicio a Clef (Cloudflare) o JEV (TypeSafe) para obtener respuestas tipadas. La decisión final (normalización, score, issues, veredicto) es determinista y la calcula el motor, no el modelo.

## Requisitos

- Node >= 22 (el proyecto se desarrolla con Node 24).
- pnpm.
- Credenciales de al menos un proveedor (o usar `mock`).

## Instalación

```bash
pnpm install
```

Crear el archivo de entorno y completar las credenciales de los proveedores que vayas a usar:

```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

```dotenv
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_API_TOKEN=<api-token>
OPENROUTER_KEY=<sk-or-...>    # opcional, provider "or"
```

Crear la configuración local a partir del ejemplo:

```bash
cp m1.config.example.json m1.config.json    # PowerShell: Copy-Item m1.config.example.json m1.config.json
```

Verificar el entorno:

```bash
pnpm m1 doctor
```

Alternativa para guardar credenciales sin `.env`:

```bash
pnpm m1 auth set cf --token <api-token> --account-id <account-id>
```

Se guardan en `~/.config/m1-agent/credentials.json` (modo 0600 best-effort). Alternativa sin guardar el secreto: `pnpm m1 auth set cf --env CLOUDFLARE_API_TOKEN` persiste sólo el nombre de la variable en `credentials.json`; el valor se lee del entorno en cada corrida.

## Quickstart

Evaluar un texto con la receta de copy:

```bash
pnpm m1 run examples/copy-checker.json \
  --state "Empezá tu prueba gratis. Sin tarjeta." \
  --json
```

Evaluar una pantalla con la receta de UX (el `--state` va al slot `brief`, la imagen al slot `screens`):

```bash
pnpm m1 run examples/ux-checker.json \
  --state "App de turnos médicos, audiencia 30-50" \
  --image ./shots/home.png \
  --json
```

Inspeccionar los requests sin llamar al proveedor:

```bash
pnpm m1 run examples/copy-checker.json --state "texto" --print-request
```

## Comandos

| Comando | Para qué | Flags principales |
| --- | --- | --- |
| `m1 run <recipe>` | Ejecuta una receta sobre un trabajo | `-i, --input <file>`, `--state <text>`, `--state-file <file>`, `--image <path>` (repetible), `--slot <name>`, `--image-slot <name>`, `--stdin`, `--provider <alias>`, `--model <id>`, `--timeout <ms>`, `--local-start <mode>`, `--dry-run`, `--print-request`, `--trace`, `--json`, `--compact`, `-c, --config <file>` |
| `m1 recipe validate <file>` | Valida esquema y reglas semánticas | `--json` |
| `m1 recipe schema` | Imprime el JSON Schema de la receta | `--json` (misma salida) |
| `m1 auth set <alias>` | Guarda credenciales del provider | `--token <key>`, `--account-id <id>`, `--env <VAR>`, `--json` |
| `m1 auth status` | Muestra providers configurados sin secretos | `--json`, `-c, --config <file>` |
| `m1 auth remove <alias>` (alias `rm`) | Borra credenciales guardadas | `--json` |
| `m1 models` | Lista los modelos disponibles del provider (Cloudflare: sólo Clef) | `--provider <alias>`, `--search <texto>`, `--free`, `--json`, `-c, --config <file>` |
| `m1 model show` | Muestra el modelo efectivo, su fuente y capacidades (visión/audio/video) | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 model use <id>` | Fija el modelo del provider | `--provider <alias>`, `--project`, `--json`, `-c, --config <file>` |
| `m1 model reset` | Borra la preferencia de modelo del usuario | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 local status` | Muestra si el servidor local está corriendo (no lo arranca) | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 local start` | Verifica y, si no responde, levanta el servidor local (idempotente) | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 local stop` | Detiene el servidor local registrado | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 doctor` | Diagnóstico de Node, config, `.env` y providers (incluye el servidor local) | `--json`, `-c, --config <file>` |
| `m1 guide` | Tutorial para agentes: comandos, salida, exit codes y recuperación de errores | `--json` |

Precedencia del modelo efectivo: `--model` (CLI) > preferencia de usuario (`~/.config/m1-agent/preferences.json`) > `provider.model` de la config > default del kind. `m1 model use` guarda en preferencias del usuario; `--project` escribe `providers.<alias>.model` en `m1.config.json`.

Notas de comportamiento:

- `--print-request` implica `--dry-run` y sale con código 0.
- `--input` y `--stdin` se combinan; `--state`, `--state-file` y `--image` se aplican después y pisan o agregan sobre lo cargado.
- `--json` tiene prioridad sobre `--compact`. Con `--json`, `--trace` no escribe en stderr.
- El timeout es **por etapa** (cada llamada al proveedor), no del run completo.

### Exit codes

| Código | Significado | Cuándo |
| --- | --- | --- |
| `0` | `pass` | Veredicto `pass`, o ejecución `--dry-run` / `--print-request` |
| `1` | `fail` | Veredicto `fail` |
| `2` | `error` | Error de uso, validación, input, config, proveedor o timeout |
| `3` | `needs_review` | Veredicto `needs_review` (criterio `blocker` con baja confianza) |

`doctor` usa 0/2. `recipe validate` usa 0/2. Cualquier error de la CLI (`fail()`) termina en 2.

## Para agentes de IA

La CLI está pensada para que la use un agente sin adivinar:

```bash
m1 guide            # tutorial completo en texto
m1 guide --json     # mismo contenido, estructurado
m1 <comando> --help # opciones y argumentos exactos
```

Contrato:

- Todo error sale por **stderr** como
  `{ ok:false, error:{ code, message, hint, details }, docs:{ guide, help, doctor, exitCodes } }`
  cuando se usa `--json`.
- Los errores de uso (`E_USAGE`) sugieren el flag o comando correcto
  (`Did you mean --json?`).
- Ramificá por exit code (`0/1/2/3`), no por el texto.
- Si el verdict es `fail`, aplicá `issues[].remediation` y volvé a correr.
- Para inspeccionar sin gastar llamadas: `--print-request` o `--dry-run`.
- Con modelo local, la primera vez puede tardar en cargar: `--timeout 300000`.

El contrato completo está en [AGENTS.md](AGENTS.md) y el manual extendido en
[docs/for-agents.md](docs/for-agents.md).

## Cómo funciona

```text
receta.json
   |
   v
validar (zod + chequeos semanticos)
   |
   v
resolver input (slots, defaults, imagenes, presupuesto)
   |
   v
planificar etapas (orden declarado)
   |
   +--> etapa 1: when? -> state (plantilla) -> imagenes -> 1 request con N preguntas
   |       |
   |       +--> normalizar cada respuesta -> scope para etapas siguientes
   |
   +--> etapa 2: ... (puede usar answers.<id> en su state y en su when)
   |
   v
derived (en orden) -> acceptance -> veredicto + score + issues
   |
   v
salida humana | compacta | JSON
```

Puntos clave:

- **Una llamada HTTP por etapa.** Dentro del request viajan todas las preguntas de la etapa; el paralelismo es del proveedor, no del motor.
- **`when` se evalúa antes de armar el state.** Si da falso, la etapa se saltea y no cuesta una llamada.
- **`state` es la única parte dinámica del request.** Las `instructions` de los criterios son estáticas; el contexto variable va en `state` mediante plantillas `{{...}}`.
- **La normalización es fija:** `noul`/`choice`/`score` se convierten a 0..1, se aplica `polarity`, se compara contra `passAt`, y se pondera por `weight`.
- **El veredicto no promedia:** se decide por acceptance y por criterios `blocker` (ver [docs/recipe-spec.md](docs/recipe-spec.md)).

## Multi-proveedor

| `kind` | Modelo por defecto | Endpoint por defecto | Imágenes | Credencial |
| --- | --- | --- | --- | --- |
| `cloudflare` | `@cf/cloudflare/clef-flash` | `https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/run/@cf/cloudflare/<model>` | Sí (los 3 Clef) | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| `typesafe` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` | No | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.14` | `https://openrouter.ai/api/v1/systemone` | Sí (según modelo) | `OPENROUTER_KEY` |
| `systemone` | `local-decision` (configurable) | `baseUrl` obligatorio | Sí | opcional (`apiKeyEnv` o `SYSTEMONE_API_KEY`); con `launch` no requiere key |
| `mock` | `mock` | — | Ignora | — |

La precedencia de secretos es: `apiKey`/`accountId` explícitos en la config > variable de entorno (`apiKeyEnv`, y `CLOUDFLARE_ACCOUNT_ID` sólo para `kind: cloudflare`) > `~/.config/m1-agent/credentials.json`. Los valores vacíos se ignoran.

Modelos Clef disponibles (todos con visión): `@cf/cloudflare/clef` (65.536 ctx, $0,24/M), `@cf/cloudflare/clef-flash` (24.576 ctx, $0,038/M) y `@cf/cloudflare/clef-omni` (65.536 ctx, $0,15/M, además audio/video). `m1 models` los consulta en vivo; `m1 model use <id>` fija el default.

OpenRouter expone modelos de decisión (`output_modalities=decisions`) con el mismo contrato System One. `m1 models --provider or` consulta el catálogo en vivo y `m1 models --provider or --free` deja sólo los gratuitos (al 2026-10-28: `baseten/mammoth-1:free`, `baseten/elephant-1:free`, `respan/span-01-lite:free`; son sólo texto). El alias de ejemplo `or` usa `baseten/mammoth-1:free`; para visión conviene `typesafe/jev-1.14` o `cloudflare/clef-*`. Los modelos `:free` tienen rate limits más bajos. Detalle del contrato en [docs/api-contract.md](docs/api-contract.md).

En OpenRouter las imágenes viajan dentro de `state` como partes `image_url` (no en un campo `images` de nivel superior). Por eso, al usar `--image` el `state` debe ser string o array; un `state` objeto produce `E_CONFIG` antes de llamar.

### Modelo local (llama.cpp)

El alias `liquid` de la config de ejemplo sirve **Liquid d1-2B** con `llama-server`: no necesita API key ni `.env`. La primera ejecución descarga el GGUF Q8_0 (≈2,5 GB); después queda en la caché de llama.cpp.

Requisitos:

- `llama-server` en el `PATH` (build reciente de llama.cpp; el soporte de d1-2B se mergeó el 2026-10-27).
- Un puerto libre; el alias usa `9931`.

```bash
pnpm m1 run examples/copy-checker.json --provider liquid \
  --state "Me cobraron dos veces este mes, necesito el reintegro"
```

Antes de llamar, `m1` sondea `GET /health` en `baseUrl`:

- Si el servidor ya responde, lo usa: no levanta nada (los runs siguientes son inmediatos).
- Si hay un servidor registrado en otro puerto, lo reutiliza.
- Si no responde, **lo levanta solo** (`launch.autoStart` default: `always`).
- `--local-start ask` pregunta en TTY; `--local-start never` falla con el comando exacto.
- **El servidor queda corriendo al terminar el run.** No se apaga solo: el usuario decide. Cerrá su consola o usá `m1 local stop`.
- En Windows se abre una **consola propia** (minimizada) titulada `m1 llama-server…`; `"launch": { "console": false }` la oculta. El log se sigue escribiendo en el archivo (`--log-file`).

**Elección de puerto:** parte de `launch.port` (9931). Si está ocupado por otro proceso, prueba 9932, 9933… hasta encontrar uno libre, arranca ahí y reescribe `baseUrl` en memoria. No hace falta tocar la config.

En Windows el arranque pasa por WMI (`Win32_Process.Create`): así el servidor no queda dentro del job de `pnpm`/`tsx` y sobrevive cuando la CLI termina. Sin eso, `pnpm run` mata el árbol de procesos al salir.

El PID, puerto y log se guardan en `~/.cache/m1-agent/local/liquid.json` (o `$M1_CACHE_DIR/local`). Eso permite reutilizar el servidor entre runs y administrarlo:

```bash
pnpm m1 local start --provider liquid   # verificas y, si no está, lo levanta
pnpm m1 local status --provider liquid
pnpm m1 local stop --provider liquid
# log: ~/.cache/m1-agent/local/logs/liquid.log
```

Detalle de `launch`:

```json
"liquid": {
  "kind": "systemone",
  "baseUrl": "http://127.0.0.1:9931/v1/systemone",
  "model": "d1-2B",
  "imageFormat": "dataUrl",
  "timeoutMs": 300000,
  "launch": {
    "command": "llama-server",
    "args": ["-hf", "LiquidAI/d1-2B-GGUF:Q8_0", "-b", "8192", "-ub", "8192"],
    "port": 9931,
    "startTimeoutMs": 240000,
    "autoStart": "always",
    "console": true
  }
}
```

- `args` admite `{port}`, `{host}`, `{model}` y `{baseUrl}`. Para `llama-server` se agregan `--port`, `--host` y `--alias <model>` si faltan; el alias hace que `/v1/models` publique el id que usa la receta.
- `autoStart`: `always` (default), `ask` o `never`.
- `console`: en Windows abre una consola propia para el servidor (default `true`). Al cerrarla se apaga; el log queda igual en `logs/<alias>.log`.
- `launch` sólo aplica a `kind: systemone` con `baseUrl` loopback.
- **Imágenes:** agregá el proyector (`--mmproj ...`) y un `-ub` suficiente. Sin `mmproj`, el servidor devuelve 501 para imágenes. d1-2B reserva como máximo la mitad de `-ub` por imagen. Con `llama.cpp` además hay que usar `"imageFormat": "dataUrl"` y cubrir los tokens de la imagen en `-b`/`-ub` (900×600 ≈ 1,8k tokens).
- **Costo por pregunta:** `/v1/systemone` procesa una tarea por pregunta y re-codifica la imagen en cada una. Medido con `d1-omni-600M` Q8_0 en CPU: 384×384 + 4 preguntas ≈ 9 s; 900×600 + 4 preguntas ≈ 108 s (+ `diagnostico` ≈ 130 s). Para recetas multimodales usá `timeoutMs`/`--timeout` de 300000; el default de 60 s corta antes.
- **Alternativas:** `LiquidAI/d1-3B-GGUF:Q8_0` (soporte más estable) o `LiquidAI/d1-omni-600M-GGUF` (imágenes + audio; requiere `--mmproj`). Cambiá `args` y `model`. En `lfm2-d1-omni` todo el prompt por pregunta se evalúa en un batch: `-ub` debe cubrirlo. El modelo está entrenado a 16.384 tokens (con imágenes, el texto se recorta a 896), aunque el GGUF declare `context_length = 128000`.

Orden de selección del provider: `--provider` > `provider` de la receta > `default` de `m1.config.json`.

### Agregar un proveedor nuevo

1. Implementar una factory en `src/providers/<nombre>.ts` que devuelva un `DecisionProvider` (`evaluate(request, options)`).
2. Agregar el `kind` a `ProviderKind` en `src/providers/types.ts`.
3. Registrarlo en `src/providers/registry.ts` (`createProvider`, `defaultModelFor`) y en `VALID_KINDS` de `src/config/config.ts` (la lista está duplicada; hay que tocar ambas).
4. Si el endpoint no es compatible con el contrato de `src/providers/types.ts`, adaptar la respuesta dentro de la factory: el motor solo consume `{ answers }`.

Un endpoint "systemone compatible" es el atajo para no escribir código: mismo body, misma respuesta y `baseUrl` configurable.

## Límites duros

| Límite | Valor | Dónde se aplica |
| --- | --- | --- |
| Preguntas por etapa | 64 | `src/schema/recipe.ts` |
| Opciones de `choice` | 2..255 | `src/schema/recipe.ts` |
| Niveles de `score` | 2..10 | `src/schema/recipe.ts` |
| Imágenes por request | 4 | `src/intake/images.ts` |
| Peso por imagen | 4 MiB | `src/intake/images.ts` |
| Total decodificado | 8 MiB | `src/intake/images.ts` |
| Body HTTP estimado | 13 MiB | `src/intake/images.ts` |
| Megapíxeles por imagen | 16 MP | `src/intake/images.ts` |
| Formatos de imagen | PNG, JPEG, WebP (por magic bytes) | `src/intake/images.ts` |
| Etapas | `limits.maxStages` (default 64) | `src/core/validate.ts` |
| Timeout por llamada | 60 s (default) | `src/core/engine.ts`, `src/providers/cloudflare.ts` |

## Testing

```bash
pnpm test              # suite completa (unitarios, e2e de CLI, tooling, integración local); live skipped
pnpm test:integration  # sólo tests/integration (systemone local; live skipped)
pnpm test:live         # live contra Cloudflare (opt-in, requiere credenciales)
pnpm lint              # ESLint flat config, type-aware en src/
pnpm typecheck
```

El pre-commit corre guardas de seguridad (leyendo el índice git), `secretlint`, ESLint con autofix, tests relacionados con el diff y typecheck condicional (sólo si hay `.ts` staged). El `commit-msg` valida Conventional Commits y el `pre-push` corre `pnpm audit --audit-level=high` si cambió el lockfile más la suite completa. Detalle de cada capa, credenciales del live y convención de commits en [docs/testing.md](docs/testing.md).

## Estado del proyecto

- Motor, validación, normalización, agregación y cuatro providers implementados.
- Recetas de ejemplo: `examples/copy-checker.json`, `examples/ux-checker.json`.
- Tests en `tests/`: unitarios, contrato de ejemplos, e2e de CLI, tooling, integración local y live opt-in.
- Pendiente: servidor **MCP** que exponga `run`/`recipe validate` como tools y el catálogo de recetas como resources.
- Pendiente: concurrencia entre etapas independientes (hoy el motor recorre las etapas en serie).

## Documentación

- [docs/recipe-spec.md](docs/recipe-spec.md) — referencia de la receta v1, expresiones, plantillas y veredicto.
- [AGENTS.md](AGENTS.md) — contrato operativo para agentes: reglas, salida JSON, exit codes y recuperación de errores.
- [docs/for-agents.md](docs/for-agents.md) — manual extendido para que otro agente use la CLI sin equivocarse.
- [docs/api-contract.md](docs/api-contract.md) — contrato de Clef/JEV y límites/costos.
- [docs/testing.md](docs/testing.md) — pirámide de tests, comandos, tests live y flujo pre-commit.

## Discrepancias detectadas

Comportamientos reales que difieren de lo que sugieren los nombres, la ayuda o la documentación previa:

1. `src/schema/recipe.ts:164` declara `outputs`, pero ningún renderer lo lee (`src/render/json.ts`, `human.ts`, `compact.ts`): la salida siempre incluye todos los campos.
2. `--print-request`/`--dry-run` no respeta `when`: `src/core/engine.ts:137-155` siembra respuestas neutras (`0.5` o la primera opción) y `src/core/engine.ts:163-179` saltea la evaluación de `when`, así que imprime todas las etapas. El veredicto del dry-run es `fail` con score 0, pero el exit code es 0 (`src/cli/commands/run.ts:141`).
3. `src/intake/images.ts:14` impone además un máximo de 16 MP por imagen, que no figuraba en la lista de límites original.
4. `.env.example` declara `LOCAL_API_KEY`, pero `src/providers/systemone.ts:44` busca `SYSTEMONE_API_KEY` por defecto: si usás el provider local sin `apiKeyEnv`, exportá `SYSTEMONE_API_KEY`.
5. El motor recorre las etapas en serie (no hay paralelismo entre etapas independientes); el paralelismo es dentro de cada request (N preguntas).
