# m1 — contrato operativo para agentes de IA

Esta es la guía que un agente debe leer antes de usar la CLI. La fuente de
verdad siempre es la propia CLI: `m1 guide --json`, `m1 <comando> --help` y
`m1 recipe schema`.

## Qué es (y qué no)

`m1` ejecuta **recetas JSON** de evaluación contra un modelo. Cada receta
declara preguntas tipadas sobre un `state`:

| tipo    | respuesta              | uso                                   |
| ------- | ---------------------- | ------------------------------------- |
| `noul`  | sí / no                | chequeos binarios                     |
| `choice`| una opción de `legend` | clasificación                         |
| `score` | nivel ordenado         | calidad, urgencia, gravedad           |

Devuelve respuestas normalizadas, `verdict`, `score`, `issues` y `remediation`.

**No es un generador de texto.** No le pidas "escribí un párrafo" ni "resumí
esto": la salida es estructurada y acotada por la receta.

## Reglas de oro

1. **Usá `--json` siempre** y parseá stdout. No parsees la salida humana.
2. **Ramificá por exit code**, no por el texto: `0` pass, `1` fail, `2` error,
   `3` needs_review.
3. **No inventes flags.** Si no conocés uno, `m1 <comando> --help`.
4. **Leé `error.hint` antes de reintentar.** No repitas el mismo comando igual.
5. Usá `--print-request` (o `--dry-run`) para inspeccionar el request sin gastar
   llamadas.
6. Antes del primer run real, `m1 doctor --json` para validar Node, config y
   providers.
7. Para imágenes locales subí `--timeout 300000` (el costo real es
   `preguntas × re-codificación de la imagen`).

## Descubrimiento

```bash
m1 guide                 # tutorial completo en texto
m1 guide --json          # mismo contenido, estructurado
m1 --help                # comandos y contrato
m1 <comando> --help      # opciones y argumentos exactos
m1 recipe schema         # JSON Schema de recetas
m1 --version             # 0.1.0
```

Manual extendido (construir entradas, escribir recetas, errores comunes):
[docs/for-agents.md](docs/for-agents.md).

`m1 guide --json` devuelve:

```json
{ "ok": true, "version": "0.1.0", "sections": [{ "id": "...", "title": "...", "body": "...", "commands": ["..."] }] }
```

## Flujo mínimo

```bash
m1 doctor --json
m1 run examples/copy-checker.json --state "texto a evaluar" --json
# exit 0 → pass | 1 → fail (leé issues[].remediation)
#          2 → error (leé error.code/hint)
#          3 → needs_review
```

## Comandos

| comando                                   | para qué                                              |
| ----------------------------------------- | ----------------------------------------------------- |
| `m1 run <receta>`                         | ejecuta la receta sobre un trabajo                    |
| `m1 recipe validate <archivo>`            | valida una receta sin ejecutarla                      |
| `m1 recipe schema`                        | imprime el JSON Schema                                |
| `m1 models [--search X] [--free]`         | catálogo de modelos del provider                      |
| `m1 model show\|use\|reset`               | modelo efectivo / fijarlo / borrar preferencia        |
| `m1 local start\|status\|stop`            | ciclo de vida del servidor local                      |
| `m1 auth set\|status\|remove`             | credenciales de providers                             |
| `m1 doctor`                               | diagnóstico de entorno y providers                    |
| `m1 guide`                                | este tutorial                                         |

Todos aceptan `--json`; `run`, `models`, `model`, `local` y `doctor` aceptan
`-c/--config <archivo>`.

## Entrada de `run`

| flag                       | significado                                          |
| -------------------------- | ---------------------------------------------------- |
| `--state "<texto>"`        | valor del slot principal (default: `state`)          |
| `--state-file <archivo>`   | igual, desde archivo                                 |
| `--input <archivo.json>`   | objeto JSON con todos los slots                      |
| `--stdin`                  | lee JSON o texto desde stdin                         |
| `--slot <nombre>`          | slot destino de `--state`/`--state-file`             |
| `--image <ruta>`           | imagen (repetible)                                   |
| `--image-slot <nombre>`    | slot destino de `--image`                            |
| `--provider <alias>`       | override del provider de la receta/config            |
| `--model <id>`             | override del modelo                                  |
| `--timeout <ms>`           | timeout por etapa                                    |

## Salida de `run --json`

```json
{
  "runId": "run_ab12cd34ef56",
  "agent": { "id": "copy-checker", "role": "copy-editor" },
  "verdict": "fail",
  "score": 48,
  "criteria": [
    {
      "id": "claridad", "type": "score", "stage": "s1",
      "raw": 0.4, "normalized": 0.4, "passAt": 0.6, "passed": false,
      "weight": 1, "severity": "major", "remediation": "Acortá las frases."
    }
  ],
  "derived": {},
  "acceptance": [{ "id": "a1", "expr": "claridad", "passed": false, "severity": "major" }],
  "issues": [{ "criterion": "claridad", "severity": "major", "message": "...", "remediation": "..." }],
  "meta": { "provider": "liquid", "model": "d1-omni-600M", "calls": 2, "durationMs": 3767, "truncated": false }
}
```

- `verdict`: `pass` | `fail` | `needs_review`.
- `issues[].remediation` es la acción concreta a ejecutar; no la inventes.
- `meta.calls` cuenta llamadas reales al modelo.

## Exit codes

| code | significado                    | qué hacer                                        |
| ---- | ------------------------------ | ------------------------------------------------ |
| `0`  | pass                           | continuar                                        |
| `1`  | fail                           | leer `issues[].remediation` y corregir el input   |
| `2`  | error de uso/config/input/proveedor | leer `error.code` y `error.hint`; corregir  |
| `3`  | needs_review                   | faltan datos o confianza baja: pedir contexto    |

## Errores (stderr)

Con `--json`:

```json
{
  "ok": false,
  "error": { "code": "E_CONFIG", "message": "...", "hint": "...", "details": {} },
  "docs": {
    "guide": "m1 guide --json",
    "help": "m1 <comando> --help",
    "doctor": "m1 doctor --json",
    "exitCodes": "0 pass · 1 fail · 2 error · 3 needs_review"
  }
}
```

| code          | causa típica                            | recuperación                                       |
| ------------- | --------------------------------------- | -------------------------------------------------- |
| `E_USAGE`     | comando/flag inválido o faltante        | `m1 <comando> --help`; la CLI sugiere el flag correcto |
| `E_VALIDATION`| receta fuera del schema                 | `m1 recipe validate <archivo>`; mirá `details`      |
| `E_INPUT`     | falta un slot o una imagen              | revisá `--state` / `--input` / `--image`            |
| `E_CONFIG`    | config o provider mal definidos         | `m1 doctor --json`; revisá `-c` y `--provider`      |
| `E_PROVIDER`  | el endpoint rechazó la llamada          | leé `hint` y `details`; no reintentes igual         |
| `E_TIMEOUT`   | la etapa superó el timeout              | subí `--timeout` (multimodal local: `300000`)       |
| `E_EXPR`      | expresión de aceptación inválida        | revisá `acceptance` en la receta                    |
| `E_INTERNAL`  | bug                                     | reportá comando e input                             |

Las sugerencias de tipeo (`Did you mean --json?`) también salen en
`error.message`.

## Modelo local

Con providers `kind: "systemone"` + `launch`, `m1` sondea `GET /health`:

- si responde, lo reutiliza (no arranca nada);
- si no responde, **lo levanta solo** (`autoStart` default `always`);
- el servidor **queda corriendo** entre runs; se apaga con
  `m1 local stop --provider <alias>` o cerrando su consola.

```bash
m1 local status --provider liquid   # exit 0 running / 2 down
m1 local start  --provider liquid   # idempotente
m1 local stop   --provider liquid
```

Si el default de la config no es local y hay un único provider local, los
comandos `local` lo usan y lo avisan por stderr.

## Configuración

Orden de búsqueda:

1. `./m1.config.json`
2. `~/.config/m1-agent/config.json`
3. config de emergencia con provider `mock` (la CLI avisa por stderr)

`-c/--config <archivo>` fuerza una ruta; `--provider <alias>` elige el alias.
Para usar `m1` desde cualquier carpeta con la config real:

```bash
mkdir -p ~/.config/m1-agent
cp m1.config.json ~/.config/m1-agent/config.json
```

## Instalación global

```bash
pnpm build
npm link          # deja `m1` en el PATH
m1 --version
```

## Reglas para agentes (resumen)

1. `--json` siempre.
2. Exit code primero, texto después.
3. `error.hint` antes de reintentar.
4. No inventes flags ni slots: `m1 <comando> --help` y `m1 recipe schema`.
5. `--print-request` antes de gastar llamadas.
6. Timeout alto para imágenes locales.
7. Si el verdict es `fail`, aplicá `issues[].remediation` y volvé a correr.