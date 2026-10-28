# Manual para agentes: usar `m1` sin equivocarse

Este documento está pensado para que otro agente o LLM invoque la CLI de forma segura. Asume que `m1` está disponible (`npx --yes -p m1-agent m1 …`, instalación global o `npm link` desde el repo) y que hay un provider configurado.

## Descubrimiento (antes de improvisar)

La CLI trae su propio tutorial y ayuda; no hace falta leer el código:

```bash
m1 guide                 # tutorial completo para agentes
m1 guide --json          # mismas secciones, estructuradas
m1 --help                # comandos y contrato
m1 <comando> --help      # opciones/argumentos del comando
m1 workflow schema       # JSON Schema de workflows
m1 --version
```

Si `m1` no está en el PATH, usalo con npx sin instalar nada:

```bash
npx --yes -p m1-agent m1 --version
```

O instalalo globalmente:

```bash
npm install -g m1-agent
m1 --version
```

## Regla de oro

Nunca ejecutes `run` a ciegas. El orden es siempre:

1. `m1 workflow schema` si no conocés el formato.
2. `m1 workflow validate <nombre>` después de escribir o editar el workflow.
3. `m1 run <workflow> ... --print-request` para ver el request exacto sin gastar una llamada.
4. `m1 run <workflow> ... --json` recién cuando el request es el esperado.

Si el paso 2 o 3 falla, no sigas: el error ya dice qué corregir. Un `run` real con un workflow inválido no aporta información nueva.

## Construir la entrada (`--input`)

`--input` recibe la ruta a un archivo JSON cuyo objeto tiene una clave por slot. No es el state: es el sobre de entrada.

```json
{
  "copy": "Empezá tu prueba gratis. Sin tarjeta.",
  "brief": "Audiencia: pymes; tono: directo"
}
```

Reglas por tipo de slot:

| Tipo | Valor esperado | Ejemplo |
| --- | --- | --- |
| `text` | string no vacío | `"copy": "texto a evaluar"` |
| `json` | cualquier valor JSON | `"payload": { "events": [] }` |
| `image` | path, data URL o `{ content_type?, base64 }` | `"shot": "./shots/home.png"` |
| `image[]` | array de 1 a `max` (default 4) de esas formas | `"screens": ["./a.png", "./b.png"]` |

Detalles:

- Los paths son relativos al working directory del proceso (o absolutos).
- `image` acepta `data:image/png;base64,...`; el tipo real se detecta por magic bytes y, si declarás `content_type`, debe coincidir.
- Si un slot opcional falta, el motor lo rellena: `text` → `""`, `image[]` → `[]`, `json`/`image` → `null`.
- Las claves no declaradas se conservan y quedan disponibles en plantillas y expresiones.
- No pongas secretos en la entrada ni en el workflow.

### Atajos sin archivo

| Querés pasar | Flag | A qué slot va |
| --- | --- | --- |
| Texto | `--state "..."` | El slot que elija `pickTextSlot` (ver abajo) |
| Archivo de texto | `--state-file ruta.txt` | Igual que `--state` |
| Imagen (repetible) | `--image ruta.png` | El primer slot `image`/`image[]`, o `--image-slot` |
| JSON o texto por pipe | `--stdin` | JSON: se mergea con `--input`; texto: va al slot de texto |

`pickTextSlot` elige, en este orden: el único slot declarado; el único slot `text`; el único slot `text` obligatorio; el slot llamado `state`. Si hay ambigüedad, usá `--slot <name>`.

`--state`, `--state-file` y `--image` se aplican **después** de `--input`, así que pisan o agregan valores.

## Escribir un workflow nuevo: checklist de 10 pasos

1. **Creá el archivo** con `m1 workflow new mi-workflow --from copy-checker` (o `--from ux-checker`). Los built-in son de sólo lectura; copiarlos es la vía soportada.
2. **Definí `id` y `role`.** El `id` es el nombre con el que se invoca (`m1 run mi-workflow`).
3. **Declará los slots** en `input.slots` con el tipo correcto y `required` solo cuando sea imprescindible.
4. **Escribí `input.state`** con las plantillas `{{slot}}` y una instrucción de tarea clara. Es el único lugar con contexto dinámico.
5. **Definí los criterios**: `noul` para sí/no, `choice` para categorías, `score` para grados. Cada uno con `instructions` accionable, `passAt`, `weight`, `severity` y `remediation`.
6. **Agrupá en etapas.** Todo lo que se puede preguntar junto va en una etapa (una llamada). Lo que depende de respuestas previas va en una etapa posterior.
7. **Agregá `when`** solo si la etapa es condicional, referenciando ids ya calculados.
8. **Agregá `derived`** si necesitás un índice compuesto; se evalúa en orden y antes de `acceptance`.
9. **Agregá `acceptance`** para las condiciones duras del negocio. `blocker`/`major` reprobadas dan `fail`; `minor`/`info` dan `needs_review`. Los criterios `blocker` también reproeban por sí solos.
10. **Validá, imprimí el request y corré**: `workflow validate`, `--print-request`, después `--json`. Probá primero con `--provider mock` para verificar el flujo.

Reglas de diseño que evitan problemas:

- Un criterio que no se pregunta en ninguna etapa genera un warning y nunca aparece en el resultado.
- No uses ids que empiecen con dígito si los vas a referenciar en expresiones sin corchetes.
- Para restar identificadores, dejá espacios: `UX-1 - 0.5`, no `UX-1-0.5`.
- No referencies un `derived` posterior desde otro `derived`: la validación no lo detecta, falla en runtime.
- Máximo 64 preguntas por etapa, 2..255 opciones de `choice`, 2..10 niveles de `score`.

## Interpretar la salida

### Elegir el modo

| flag | tamaño | uso |
| --- | --- | --- |
| `--agent` | ~200 tokens | **default para agentes**: decidir y actuar |
| `--json` | completo | auditar, depurar, ver probabilidades y trace |
| `--compact` | una línea | logs de CI |
| (sin flag) | texto | mostrar al usuario |

### Salida `--agent`

```json
{
  "ok": true,
  "runId": "run_0fe9f606a4d0",
  "workflow": "copy-checker",
  "verdict": "fail",
  "score": 60,
  "issues": [
    { "criterion": "CP-4", "severity": "major", "message": "Corrección: 0.52 < 0.8", "remediation": "Pasá corrector." }
  ],
  "gates": [{ "id": "A3", "expr": "quality >= 0.7", "severity": "major", "detail": "quality = 0.6" }],
  "derived": { "quality": 0.6 },
  "passed": ["CP-3", "CP-5"],
  "meta": { "provider": "liquid", "model": "d1-omni-600M", "calls": 2, "ms": 15970 }
}
```

`gates` son los `acceptance` que fallaron: explican un `fail` global cuando ningún criterio puntual falló (por ejemplo `quality < 0.7`). `detail` trae el valor actual del símbolo para que no tengas que recalcularlo.

### Salida JSON (`--json`)

```json
{
  "runId": "run_ab12cd34ef56",
  "agent": { "id": "copy-checker", "role": "Editor de copy" },
  "verdict": "pass",
  "score": 78,
  "criteria": [
    {
      "id": "CP-1",
      "name": "Claridad",
      "type": "score",
      "stage": "base",
      "raw": 3,
      "normalized": 1,
      "passed": true,
      "confidence": 0.82,
      "probabilities": { "0": 0.02, "1": 0.05, "2": 0.11, "3": 0.82 },
      "weight": 0.3,
      "severity": "major",
      "remediation": "..."
    }
  ],
  "derived": { "quality": 0.81 },
  "acceptance": [{ "id": "A1", "expr": "CP-3 >= 0.7", "passed": true, "severity": "blocker" }],
  "issues": [],
  "meta": {
    "provider": "cf",
    "model": "@cf/cloudflare/clef-flash",
    "calls": 1,
    "inputTokens": 812,
    "outputTokens": 0,
    "durationMs": 1830,
    "truncated": false
  },
  "trace": [{ "id": "base", "status": "ran", "questions": ["CP-1", "..."] }]
}
```

| Campo | Uso |
| --- | --- |
| `verdict` | `pass`, `fail` o `needs_review`. Mapea al exit code. |
| `score` | 0..100, ponderado por `weight`. Es informativo: no decide el veredicto. |
| `criteria[]` | Una entrada por criterio respondido, con `raw`, `normalized` (polarity aplicada), `passed` y `remediation`. |
| `derived` | Valores numéricos calculados. |
| `acceptance[]` | Resultado de cada condición dura. |
| `issues[]` | Solo criterios que no pasaron; ordenados por severidad y luego por id. `remediation` es la acción sugerida. |
| `meta.calls` | Cantidad de requests realmente ejecutados. Si es menor que las etapas, hubo `when` falsos. |
| `meta.inputTokens`/`outputTokens` | Uso reportado por el proveedor; `0` si no lo reporta. |
| `meta.truncated` | Reservado; hoy siempre `false`. |
| `trace[]` | Estado por etapa: `ran`, `skipped` (con `reason`) o `error`. |

### Qué hacer según el exit code

| Exit | `verdict` | Acción del agente |
| --- | --- | --- |
| `0` | `pass` | Aceptar. Si hubo `--dry-run` o `--print-request`, no hubo veredicto real: el 0 solo indica que el request se armó. |
| `1` | `fail` | Leer `issues[]`, aplicar `remediation` y volver a evaluar. No es un error de infraestructura. |
| `2` | — | Error. Parsear el JSON de stderr, corregir según `error.code` y `error.hint`. No reintentar igual. |
| `3` | `needs_review` | Un criterio `blocker` tiene confianza baja, o un `acceptance` `minor`/`info` falló. Escalar a revisión humana o subir evidencia/contexto y reejecutar. |

En errores con `--json`, el JSON va a **stderr** y el stdout queda vacío:

```json
{
  "ok": false,
  "error": {
    "code": "E_INPUT",
    "message": "falta el slot obligatorio \"copy\"",
    "hint": "tipo esperado: text; ejemplo: {\"copy\": \"texto\"}",
    "details": { "path": "input.copy", "expected": "text" }
  },
  "docs": {
    "guide": "m1 guide --json",
    "help": "m1 <comando> --help",
    "doctor": "m1 doctor --json",
    "exitCodes": "0 pass · 1 fail · 2 error · 3 needs_review"
  }
}
```

Códigos: `E_USAGE`, `E_VALIDATION`, `E_INPUT`, `E_CONFIG`, `E_PROVIDER`, `E_TIMEOUT`, `E_EXPR`, `E_INTERNAL`.

Los errores de uso (`E_USAGE`) incluyen la sugerencia de tipeo en `message`
(`unknown option '--jsn' (Did you mean --json?)`) y un `hint` que apunta a
`m1 guide` / `m1 <comando> --help`. En modo humano, la CLI imprime además una
línea `más: m1 guide · m1 <comando> --help`.

## Workflows: dónde viven y cómo se invocan

- Se invocan **sólo por nombre**: `m1 run copy-checker`. Sin ruta, sin `.json`.
- **Built-in** (de sólo lectura): `copy-checker`, `ux-checker`. Salen del `examples/` del paquete.
- **De usuario**: `~/.config/m1-agent/workflows/<nombre>.json` (override: `M1_WORKFLOWS_DIR`).
- Nombres válidos: `^[a-z0-9][a-z0-9-]{0,63}$`.
- Un workflow de usuario con el mismo nombre que uno built-in lo **pisa**.
- `m1 workflow list` es la fuente de verdad de qué hay disponible.
- Escape hatch para CI: pasar una ruta `.json` a `run`/`workflow validate` sigue funcionando.

## Modelo local (systemone + launch)

Con un provider `kind: "systemone"` que tenga `launch`, `m1` administra el
servidor:

```bash
m1 local status --provider liquid   # exit 0 running / 2 down
m1 local start  --provider liquid   # verifica y, si no responde, lo levanta
m1 local stop   --provider liquid   # lo apaga
```

- Al correr `run`, `m1` sondea `/health`; si no responde, lo levanta solo
  (`autoStart` default `always`).
- El servidor **queda corriendo** entre runs (el modelo ya está cargado). Lo
  apaga el usuario con `local stop` o cerrando su consola.
- Si el default de la config no es local y hay un único provider local, los
  comandos `local` lo usan y avisan por stderr.
- En Windows se abre una consola propia (minimizada); el log queda en
  `~/.cache/m1-agent/local/logs/<alias>.log`.
- Si usás un provider cloud por error, el hint lista los aliases locales y el
  comando exacto.
- **Modelo:** `provider.model` acepta un repo de HuggingFace (`org/repo:quant`,
  se pasa como `-hf`) o una ruta `.gguf` (`-m`). Si no hay modelo, el provider
  igual arranca y el servidor decide.
- **Descarga:** si el GGUF no está en la caché, en TTY pregunta antes de bajar.
  Sin TTY falla con el comando exacto. Para automatizar: `--download`.
- `launch.mmproj` agrega `--mmproj <ruta>` para visión.

## Errores comunes y su fix

| Síntoma / mensaje | Causa | Fix |
| --- | --- | --- |
| `falta el slot obligatorio "X"` | La entrada no trae una clave requerida | Agregarla al JSON de `--input`, o usar `--state`/`--slot` |
| `no hay entrada para evaluar` | No se pasó nada | `--input`, `--state`, `--state-file`, `--image` o `--stdin` |
| `no se pudo determinar el slot para --state` (o `--state-file`) | Hay varios slots de texto | `--slot <name>` |
| `referencia de plantilla desconocida` | `{{...}}` apunta a algo que no existe en el state | Revisar el nombre: `{{answers.<id>.normalized}}`, `{{criteria.<id>}}`, `{{slot}}` |
| `referencia desconocida: "X"` en `when`/`derived`/`acceptance` | Id mal escrito o no declarado | Corregir el id; `workflow validate` lo detecta antes de correr |
| `referencia desconocida: "X"` en `when` de una etapa | El id existe, pero pertenece a una etapa posterior | Mover la etapa o quitar la dependencia; la validación semántica no mira el orden |
| `la etapa "X" tiene un "when" inválido` | Expresión mal formada | Ver gramática en `docs/workflow-spec.md`; ids con guiones y resta con espacios |
| `provider "X" no está configurado` | Alias inexistente | `m1 provider list` o revisar `providers` en la config global |
| `falta accountId de Cloudflare` / `falta API token` | Sin credenciales | Completar `.env` o `m1 auth set cf --token ... --account-id ...` |
| `falta API key de TypeSafe` | Sin credenciales | `TYPESAFE_API_KEY` o `m1 auth set ts --token ...` |
| `Cloudflare 401` / `403` | Token inválido o sin permiso de Workers AI | Regenerar token con el permiso correcto |
| `Cloudflare 429` / `TypeSafe 429` | Rate limit | Esperar, bajar concurrencia o reintentar más tarde |
| `Cloudflare 404` | `accountId` incorrecto o modelo no habilitado | Verificar cuenta y modelo |
| `la imagen N (...) pesa ... el máximo por imagen es 4194304` | Imagen > 4 MiB | Comprimir o redimensionar |
| `las imágenes suman ... el máximo total es ... 8 MiB` | Total decodificado > 8 MiB | Reducir cantidad o tamaño |
| `formato de imagen no soportado` | No es PNG/JPEG/WebP real | Convertir el archivo |
| `choice requiere entre 2 y 255 opciones` | `criteria` con menos de 2 opciones | Agregar al menos una alternativa |
| `score requiere entre 2 y 10 niveles` | `criteria` con menos de 2 niveles | Agregar niveles ordenados |
| `la etapa "X" pregunta un criterio inexistente` | Id mal escrito en `questions` | Corregir contra `criteria[].id` |
| `faltó la respuesta para "X" en la etapa "Y"` | El proveedor omitió una pregunta | Reintentar; si persiste, dividir la etapa |
| `JEV no soporta imágenes` | `typesafe` con imágenes | Quitar `--image` o usar `cloudflare`/`systemone` |
| `timeout tras Nms` | Etapa lenta | Subir `--timeout`, simplificar el state o dividir la etapa |
| `E_EXPR: el operador "-" requiere números` | Resta entre identificadores sin espacios | `UX-1 - 0.5` |
| `el input debe ser un objeto JSON con los slots` | `--input` apunta a un array o escalar | Envolver en un objeto |

## Comandos copy-paste

> Si instalaste globalmente usá `m1`; si no, `npx --yes -p m1-agent m1`; dentro del repo, `pnpm m1`.

```bash
# Descubrimiento
m1 guide
m1 guide --json
m1 --version
m1 --help
m1 run --help

# Workflows
m1 workflow list
m1 workflow show copy-checker
m1 workflow explain copy-checker          # qué pregunta, con qué umbral y por qué pasa o falla
m1 workflow new mi-copy --from copy-checker --description "Copy para landing"
m1 workflow validate mi-copy
m1 workflow export mi-copy --out ./mi-copy.json
m1 workflow import ./mi-copy.json --name mi-copy-2
m1 workflow delete mi-copy --yes
m1 workflow schema
m1 workflow guide

# Providers
m1 provider presets
m1 provider list
m1 provider add cf --preset cloudflare --api-key <token> --account-id <id> --default
m1 provider add local --preset llamacpp
m1 provider edit local --model LiquidAI/d1-omni-600M-GGUF:Q8_0
m1 provider test local
m1 provider set-default local
m1 provider remove local --yes

# Servidor local
m1 local status --provider liquid
m1 local start  --provider liquid
m1 local start  --provider liquid --download
m1 local stop   --provider liquid

# Imprimir el JSON Schema del workflow
m1 workflow schema

# Validar un workflow (por nombre o, en CI, por ruta)
m1 workflow validate copy-checker
m1 workflow validate ./mi-workflow.json --json

# Diagnóstico del entorno
m1 doctor
m1 doctor --json

# Ejecutar con texto
m1 run copy-checker --slot copy --state "Empezá tu prueba gratis." --json

# Ejecutar con archivo de texto
m1 run copy-checker --state-file ./copy.txt --json

# Ejecutar con JSON de entrada
m1 run copy-checker --input ./entrada.json --json

# Ejecutar con imagen (repetible)
m1 run ux-checker --image ./shots/home.png --image ./shots/mobile.png --state "brief" --json

# Ejecutar con datos por stdin (PowerShell)
Get-Content ./entrada.json | m1 run copy-checker --stdin --json
# POSIX: cat ./entrada.json | m1 run copy-checker --stdin --json

# Ver el request sin llamar al proveedor
m1 run copy-checker --slot copy --state "texto" --print-request

# Dry-run explícito
m1 run copy-checker --slot copy --state "texto" --dry-run --trace

# Forzar proveedor y modelo
m1 run copy-checker --slot copy --state "texto" --provider mock --json
m1 run copy-checker --slot copy --state "texto" --provider cf --model @cf/cloudflare/clef --json

# Timeout por etapa
m1 run copy-checker --slot copy --state "texto" --timeout 90000 --json

# Salida mínima para agentes (recomendada): ~200 tokens, sólo lo accionable
m1 run copy-checker --slot copy --state "texto" --agent

# Salida compacta de una línea (logs)
m1 run copy-checker --slot copy --state "texto" --compact

# Config alternativa
m1 run copy-checker --slot copy --state "texto" -c ./m1.config.local.json --json

# Credenciales (equivalente a provider add/edit con --api-key)
m1 auth set cf --token <token> --account-id <account-id>
m1 auth status
m1 auth status --json
m1 auth remove cf
```

## Discrepancias detectadas

1. `src/cli/commands/run.ts:141`: con `--dry-run` o `--print-request` el exit code siempre es 0, aunque el veredicto interno sea `fail`.
2. `--print-request` imprime todas las etapas, incluso las que un `when` saltearía en una corrida real (`src/core/engine.ts:137-179`).
3. `.env.example` declara `LOCAL_API_KEY`, pero `src/providers/systemone.ts:44` usa `SYSTEMONE_API_KEY` por defecto si el provider no define `apiKeyEnv`.
