# m1-agent

CLI y motor de flujo para **agentes de decisión** definidos en JSON. No es un LLM: interpreta un workflow, arma las preguntas y delega el juicio a Clef (Cloudflare), JEV (TypeSafe), OpenRouter o un endpoint compatible (incluido llama.cpp local). La decisión final (normalización, score, issues, veredicto) es determinista y la calcula el motor, no el modelo.

## Empezar en 3 comandos

Lo primero es el provider: sin uno, `m1` cae en un `mock` de emergencia y los veredictos son simulados, no reales.

```bash
npx --yes -p m1-agent m1 provider presets          # 1. elegí un preset
npx --yes -p m1-agent m1 provider add cf --preset cloudflare --api-key <token> --account-id <id> --default
npx --yes -p m1-agent m1 run copy-checker --slot copy --state "Empezá tu prueba gratis." --json
```

`m1 doctor` te dice en cualquier momento qué falta. El paquete expone dos binarios equivalentes: `m1-agent` y `m1`.

## Requisitos

- Node >= 22 (el proyecto se desarrolla con Node 24).
- Un provider configurado (o el `mock` de emergencia).

## Instalación

Global, con npm:

```bash
npm install -g m1-agent
m1 provider presets
```

O desde el repo:

```bash
pnpm install
pnpm build
npm link        # deja `m1` en el PATH
```

## Configurar un provider

Los providers se guardan en la config **global** (`~/.config/m1-agent/config.json`); las API keys van a `~/.config/m1-agent/credentials.json` (nunca al JSON de config).

```bash
m1 provider presets
m1 provider add cf --preset cloudflare --api-key <token> --account-id <id> --default
m1 provider add or --preset openrouter --api-key <sk-or-...>
m1 provider list
```

También podés apuntar a cualquier endpoint compatible con URL y API key opcional:

```bash
m1 provider add mio --preset custom --base-url http://127.0.0.1:8080/v1/systemone
```

Variables de entorno equivalentes (alternativa a `--api-key`): `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `OPENROUTER_KEY`, `TYPESAFE_API_KEY`.

## Quickstart

Los workflows se invocan **sólo por nombre** (sin ruta ni `.json`). Los built-in son de sólo lectura:

```bash
m1 workflow list
m1 run copy-checker --slot copy --state "Empezá tu prueba gratis. Sin tarjeta." --json
```

Evaluar una pantalla con el workflow de UX (el `--state` va al slot `brief`, la imagen al slot `screens`):

```bash
m1 run ux-checker \
  --state "App de turnos médicos, audiencia 30-50" \
  --image ./shots/home.png \
  --json
```

Crear tu propio workflow a partir de un built-in:

```bash
m1 workflow new mi-copy --from copy-checker --description "Copy para landing"
m1 workflow validate mi-copy
m1 run mi-copy --slot copy --state "texto" --json
```

Inspeccionar los requests sin llamar al proveedor:

```bash
m1 run copy-checker --slot copy --state "texto" --print-request
```

## Comandos

| Comando | Para qué | Flags principales |
| --- | --- | --- |
| `m1 run <workflow>` | Ejecuta un workflow (por nombre) sobre un trabajo | `-i, --input <file>`, `--state <text>`, `--state-file <file>`, `--image <path>` (repetible), `--slot <name>`, `--image-slot <name>`, `--stdin`, `--provider <alias>`, `--model <id>`, `--timeout <ms>`, `--local-start <mode>`, `--download`, `--dry-run`, `--print-request`, `--trace`, `--json`, `--compact`, `-c, --config <file>` |
| `m1 workflow list` (alias `ls`) | Lista nombre, tipo y descripción de los workflows | `--json` |
| `m1 workflow show <name>` | Muestra el JSON completo y su metadata | `--json` |
| `m1 workflow new <name>` (alias `create`) | Crea un workflow de usuario | `--from <name>`, `--role <role>`, `--description <text>`, `--json` |
| `m1 workflow import <file>` | Importa un workflow desde JSON | `--name <name>`, `--json` |
| `m1 workflow export <name>` | Exporta un workflow | `--out <file>` |
| `m1 workflow edit <name>` | Abre `$EDITOR` y valida al guardar | `--json` |
| `m1 workflow delete <name>` (alias `rm`) | Borra un workflow de usuario (los built-in no) | `--yes`, `--json` |
| `m1 workflow validate <name\|file>` | Valida esquema y reglas semánticas | `--json` |
| `m1 workflow schema` | Imprime el JSON Schema de un workflow | `--json` (misma salida) |
| `m1 workflow guide` | Guía de autoría para agentes (formato + esqueleto) | `--json` |
| `m1 provider list` (alias `ls`) | Lista los providers de la config global | `--json` |
| `m1 provider presets` | Presets: cloudflare, openrouter, typesafe, llamacpp, custom | `--json` |
| `m1 provider show <alias>` | Muestra un provider sin secretos | `--json` |
| `m1 provider add <alias>` | Agrega un provider (global) | `--preset <id>`, `--kind <kind>`, `--base-url <url>`, `--model <id>`, `--api-key <key>`, `--api-key-env <VAR>`, `--account-id <id>`, `--default`, `--json` |
| `m1 provider edit <alias>` | Cambia sólo los campos indicados | `--base-url`, `--model`, `--api-key`, `--api-key-env`, `--account-id`, `--clear-api-key`, `--json` |
| `m1 provider remove <alias>` (alias `rm`) | Elimina provider y credencial | `--yes`, `--force`, `--json` |
| `m1 provider set-default <alias>` (alias `use`) | Fija el provider default | `--json` |
| `m1 provider test <alias>` | Chequeos estructurales, sin red | `--json` |
| `m1 auth set <alias>` | Guarda credenciales del provider | `--token <key>`, `--account-id <id>`, `--env <VAR>`, `--json` |
| `m1 auth status` | Muestra providers configurados sin secretos | `--json`, `-c, --config <file>` |
| `m1 auth remove <alias>` (alias `rm`) | Borra credenciales guardadas | `--json` |
| `m1 models` | Lista los modelos disponibles del provider (Cloudflare: sólo Clef) | `--provider <alias>`, `--search <texto>`, `--free`, `--json`, `-c, --config <file>` |
| `m1 model show` | Muestra el modelo efectivo, su fuente y capacidades (visión/audio/video) | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 model use <id>` | Fija el modelo del provider | `--provider <alias>`, `--project`, `--json`, `-c, --config <file>` |
| `m1 model reset` | Borra la preferencia de modelo del usuario | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 local status` | Muestra si el servidor local está corriendo (no lo arranca) | `--provider <alias>`, `--json`, `-c, --config <file>` |
| `m1 local start` | Verifica y, si no responde, levanta el servidor local (idempotente) | `--provider <alias>`, `--download`, `--json`, `-c, --config <file>` |
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

`doctor` usa 0/2. `workflow validate` usa 0/2. Cualquier error de la CLI (`fail()`) termina en 2.

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

El contrato completo está en [AGENTS.md](https://github.com/rey9606/m1-agent-mcp/blob/main/AGENTS.md) y el manual extendido en
[docs/for-agents.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/for-agents.md).

## Cómo funciona

```text
workflow.json
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
- **El veredicto no promedia:** se decide por acceptance y por criterios `blocker` (ver [docs/workflow-spec.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/workflow-spec.md)).

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

OpenRouter expone modelos de decisión (`output_modalities=decisions`) con el mismo contrato System One. `m1 models --provider or` consulta el catálogo en vivo y `m1 models --provider or --free` deja sólo los gratuitos (al 2026-10-28: `baseten/mammoth-1:free`, `baseten/elephant-1:free`, `respan/span-01-lite:free`; son sólo texto). El alias de ejemplo `or` usa `baseten/mammoth-1:free`; para visión conviene `typesafe/jev-1.14` o `cloudflare/clef-*`. Los modelos `:free` tienen rate limits más bajos. Detalle del contrato en [docs/api-contract.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/api-contract.md).

En OpenRouter las imágenes viajan dentro de `state` como partes `image_url` (no en un campo `images` de nivel superior). Por eso, al usar `--image` el `state` debe ser string o array; un `state` objeto produce `E_CONFIG` antes de llamar.

### Modelo local (llama.cpp)

El preset `llamacpp` crea un provider `kind: systemone` con `llama-server`, **sin modelo asociado**: el modelo se configura con `provider.model`, ya sea un repo de HuggingFace (`org/repo:quant`) o la ruta a un `.gguf`.

```bash
m1 provider add local --preset llamacpp
m1 provider edit local --model LiquidAI/d1-omni-600M-GGUF:Q8_0
m1 local start --provider local
m1 run copy-checker --provider local --slot copy --state "texto"
```

Requisitos:

- `llama-server` en el `PATH`, o `launch.command` con la ruta absoluta.
- Un puerto libre; el preset usa `9931`.

Antes de llamar, `m1` sondea `GET /health` en `baseUrl`:

- Si el servidor ya responde, lo usa: no levanta nada (los runs siguientes son inmediatos).
- Si hay un servidor registrado en otro puerto, lo reutiliza.
- Si no responde, **lo levanta solo** (`launch.autoStart` default: `always`).
- `--local-start ask` pregunta en TTY; `--local-start never` falla con el comando exacto.
- **El servidor queda corriendo al terminar el run.** No se apaga solo: el usuario decide. Cerrá su consola o usá `m1 local stop`.
- En Windows se abre una **consola propia** (minimizada) titulada `m1 llama-server…`; `"launch": { "console": false }` la oculta. El log se sigue escribiendo en el archivo (`--log-file`).

**Modelo y descarga:** si `provider.model` es un repo de HuggingFace y todavía no hay un `.gguf` en la caché, `m1` pregunta antes de descargar. Sin TTY falla con el comando exacto; para automatizar usá `--download`:

```bash
m1 local start --provider local --download
m1 run copy-checker --provider local --slot copy --state "texto" --download
```

La descarga la hace el propio `llama-server -hf <repo>:<quant>` y queda en la caché de HuggingFace. Si `provider.model` es una ruta `.gguf`, se usa `-m <ruta>`.

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
  "model": "LiquidAI/d1-omni-600M-GGUF:Q8_0",
  "imageFormat": "dataUrl",
  "timeoutMs": 300000,
  "launch": {
    "command": "llama-server",
    "args": ["-b", "8192", "-ub", "8192"],
    "mmproj": "C:/ruta/mmproj-d1-omni-600M-Q8_0.gguf",
    "port": 9931,
    "startTimeoutMs": 240000,
    "autoStart": "always",
    "console": true
  }
}
```

- `provider.model` elige el modelo: `org/repo:quant` se pasa como `-hf`, y una ruta `.gguf` como `-m`. Si `launch.args` ya trae `-m`, `--model`, `-hf` o `--hf-repo`, esos args mandan y no se agrega nada.
- `launch.mmproj` agrega `--mmproj <ruta>` (necesario para visión).
- `args` admite `{port}`, `{host}`, `{model}` y `{baseUrl}`. Para `llama-server` se agregan `--port`, `--host` y `--alias <model>` si faltan; el alias hace que `/v1/models` publique el id que usa el workflow.
- `autoStart`: `always` (default), `ask` o `never`.
- `console`: en Windows abre una consola propia para el servidor (default `true`). Al cerrarla se apaga; el log queda igual en `logs/<alias>.log`.
- `launch` sólo aplica a `kind: systemone` con `baseUrl` loopback.
- **Imágenes:** agregá el proyector (`--mmproj ...`) y un `-ub` suficiente. Sin `mmproj`, el servidor devuelve 501 para imágenes. d1-2B reserva como máximo la mitad de `-ub` por imagen. Con `llama.cpp` además hay que usar `"imageFormat": "dataUrl"` y cubrir los tokens de la imagen en `-b`/`-ub` (900×600 ≈ 1,8k tokens).
- **Costo por pregunta:** `/v1/systemone` procesa una tarea por pregunta y re-codifica la imagen en cada una. Medido con `d1-omni-600M` Q8_0 en CPU: 384×384 + 4 preguntas ≈ 9 s; 900×600 + 4 preguntas ≈ 108 s (+ `diagnostico` ≈ 130 s). Para workflows multimodales usá `timeoutMs`/`--timeout` de 300000; el default de 60 s corta antes.
- **Alternativas:** `LiquidAI/d1-3B-GGUF:Q8_0` (soporte más estable) o `LiquidAI/d1-omni-600M-GGUF` (imágenes + audio; requiere `--mmproj`). Cambiá `model`. En `lfm2-d1-omni` todo el prompt por pregunta se evalúa en un batch: `-ub` debe cubrirlo. El modelo está entrenado a 16.384 tokens (con imágenes, el texto se recorta a 896), aunque el GGUF declare `context_length = 128000`.

Orden de selección del provider: `--provider` > `provider` del workflow > `default` de `m1.config.json`.

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

El pre-commit corre guardas de seguridad (leyendo el índice git), `secretlint`, ESLint con autofix, tests relacionados con el diff y typecheck condicional (sólo si hay `.ts` staged). El `commit-msg` valida Conventional Commits y el `pre-push` corre `pnpm audit --audit-level=high` si cambió el lockfile más la suite completa. Detalle de cada capa, credenciales del live y convención de commits en [docs/testing.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/testing.md).

## Estado del proyecto

- Motor, validación, normalización, agregación y cuatro providers implementados.
- Workflows built-in: `copy-checker` y `ux-checker` (definidos en `examples/`, de sólo lectura).
- Tests en `tests/`: unitarios, contrato de ejemplos, e2e de CLI, tooling, integración local y live opt-in.
- Pendiente: servidor **MCP** que exponga `run`/`workflow validate` como tools y el catálogo de workflows como resources.
- Pendiente: concurrencia entre etapas independientes (hoy el motor recorre las etapas en serie).

## Documentación

- [docs/workflow-spec.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/workflow-spec.md) — referencia del formato v1, expresiones, plantillas y veredicto.
- [AGENTS.md](https://github.com/rey9606/m1-agent-mcp/blob/main/AGENTS.md) — contrato operativo para agentes: reglas, salida JSON, exit codes y recuperación de errores.
- [docs/for-agents.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/for-agents.md) — manual extendido para que otro agente use la CLI sin equivocarse.
- [docs/api-contract.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/api-contract.md) — contrato de Clef/JEV y límites/costos.
- [docs/testing.md](https://github.com/rey9606/m1-agent-mcp/blob/main/docs/testing.md) — pirámide de tests, comandos, tests live y flujo pre-commit.

## Discrepancias detectadas

Comportamientos reales que difieren de lo que sugieren los nombres, la ayuda o la documentación previa:

1. `src/schema/recipe.ts:164` declara `outputs`, pero ningún renderer lo lee (`src/render/json.ts`, `human.ts`, `compact.ts`): la salida siempre incluye todos los campos.
2. `--print-request`/`--dry-run` no respeta `when`: `src/core/engine.ts:137-155` siembra respuestas neutras (`0.5` o la primera opción) y `src/core/engine.ts:163-179` saltea la evaluación de `when`, así que imprime todas las etapas. El veredicto del dry-run es `fail` con score 0, pero el exit code es 0 (`src/cli/commands/run.ts:141`).
3. `src/intake/images.ts:14` impone además un máximo de 16 MP por imagen, que no figuraba en la lista de límites original.
4. `.env.example` declara `LOCAL_API_KEY`, pero `src/providers/systemone.ts:44` busca `SYSTEMONE_API_KEY` por defecto: si usás el provider local sin `apiKeyEnv`, exportá `SYSTEMONE_API_KEY`.
5. El motor recorre las etapas en serie (no hay paralelismo entre etapas independientes); el paralelismo es dentro de cada request (N preguntas).
