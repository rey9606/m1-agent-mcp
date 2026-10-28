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

Crear el archivo de entorno y completar las credenciales de Cloudflare:

```bash
cp .env.example .env          # PowerShell: Copy-Item .env.example .env
```

```dotenv
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_API_TOKEN=<api-token>
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
| `m1 run <recipe>` | Ejecuta una receta sobre un trabajo | `-i, --input <file>`, `--state <text>`, `--state-file <file>`, `--image <path>` (repetible), `--slot <name>`, `--image-slot <name>`, `--stdin`, `--provider <alias>`, `--model <id>`, `--timeout <ms>`, `--dry-run`, `--print-request`, `--trace`, `--json`, `--compact`, `-c, --config <file>` |
| `m1 recipe validate <file>` | Valida esquema y reglas semánticas | `--json` |
| `m1 recipe schema` | Imprime el JSON Schema de la receta | `--json` (misma salida) |
| `m1 auth set <alias>` | Guarda credenciales del provider | `--token <key>`, `--account-id <id>`, `--env <VAR>`, `--json` |
| `m1 auth status` | Muestra providers configurados sin secretos | `--json`, `-c, --config <file>` |
| `m1 auth remove <alias>` (alias `rm`) | Borra credenciales guardadas | `--json` |
| `m1 doctor` | Diagnóstico de Node, config, `.env` y providers | `--json`, `-c, --config <file>` |

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
| `cloudflare` | `@cf/cloudflare/clef-flash` | `https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/run/@cf/cloudflare/<model>` | Sí | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| `typesafe` | `jev-latest` | `https://api.typesafe.ai/v1/systemone` | No | `TYPESAFE_API_KEY` |
| `systemone` | `local-decision` (configurable) | `baseUrl` obligatorio | Sí | opcional (`apiKeyEnv` o `SYSTEMONE_API_KEY`) |
| `mock` | `mock` | — | Ignora | — |

La precedencia de secretos es: `apiKey`/`accountId` explícitos en la config > variable de entorno (`apiKeyEnv`, y `CLOUDFLARE_ACCOUNT_ID` sólo para `kind: cloudflare`) > `~/.config/m1-agent/credentials.json`. Los valores vacíos se ignoran.

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
pnpm test              # suite completa (unitarios, e2e de CLI, integración local); live skipped
pnpm test:integration  # sólo tests/integration (systemone local; live skipped)
pnpm test:live         # live contra Cloudflare (opt-in, requiere credenciales)
pnpm typecheck
```

El pre-commit corre guardas de secretos, validación de recetas de `examples/`, tests relacionados con el diff y typecheck. Detalle de cada capa, credenciales del live y convención de commits en [docs/testing.md](docs/testing.md).

## Estado del proyecto

- Motor, validación, normalización, agregación y cuatro providers implementados.
- Recetas de ejemplo: `examples/copy-checker.json`, `examples/ux-checker.json`.
- Tests en `tests/`: unitarios, contrato de ejemplos, e2e de CLI, tooling, integración local y live opt-in.
- Pendiente: servidor **MCP** que exponga `run`/`recipe validate` como tools y el catálogo de recetas como resources.
- Pendiente: concurrencia entre etapas independientes (hoy el motor recorre las etapas en serie).

## Documentación

- [docs/recipe-spec.md](docs/recipe-spec.md) — referencia de la receta v1, expresiones, plantillas y veredicto.
- [docs/for-agents.md](docs/for-agents.md) — manual para que otro agente use la CLI sin equivocarse.
- [docs/api-contract.md](docs/api-contract.md) — contrato de Clef/JEV y límites/costos.
- [docs/testing.md](docs/testing.md) — pirámide de tests, comandos, tests live y flujo pre-commit.

## Discrepancias detectadas

Comportamientos reales que difieren de lo que sugieren los nombres, la ayuda o la documentación previa:

1. `src/schema/recipe.ts:164` declara `outputs`, pero ningún renderer lo lee (`src/render/json.ts`, `human.ts`, `compact.ts`): la salida siempre incluye todos los campos.
2. `--print-request`/`--dry-run` no respeta `when`: `src/core/engine.ts:137-155` siembra respuestas neutras (`0.5` o la primera opción) y `src/core/engine.ts:163-179` saltea la evaluación de `when`, así que imprime todas las etapas. El veredicto del dry-run es `fail` con score 0, pero el exit code es 0 (`src/cli/commands/run.ts:141`).
3. `src/intake/images.ts:14` impone además un máximo de 16 MP por imagen, que no figuraba en la lista de límites original.
4. `.env.example` declara `LOCAL_API_KEY`, pero `src/providers/systemone.ts:44` busca `SYSTEMONE_API_KEY` por defecto: si usás el provider local sin `apiKeyEnv`, exportá `SYSTEMONE_API_KEY`.
5. El motor recorre las etapas en serie (no hay paralelismo entre etapas independientes); el paralelismo es dentro de cada request (N preguntas).
