# Manual para agentes: usar `m1` sin equivocarse

Este documento está pensado para que otro agente o LLM invoque la CLI de forma segura. Asume que el repositorio ya está instalado (`pnpm install`) y que existe `m1.config.json`.

## Regla de oro

Nunca ejecutes `run` a ciegas. El orden es siempre:

1. `m1 recipe schema` si no conocés el formato.
2. `m1 recipe validate <receta>` después de escribir o editar la receta.
3. `m1 run <receta> ... --print-request` para ver el request exacto sin gastar una llamada.
4. `m1 run <receta> ... --json` recién cuando el request es el esperado.

Si el paso 2 o 3 falla, no sigas: el error ya dice qué corregir. Un `run` real con una receta inválida no aporta información nueva.

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
- No pongas secretos en la entrada ni en la receta.

### Atajos sin archivo

| Querés pasar | Flag | A qué slot va |
| --- | --- | --- |
| Texto | `--state "..."` | El slot que elija `pickTextSlot` (ver abajo) |
| Archivo de texto | `--state-file ruta.txt` | Igual que `--state` |
| Imagen (repetible) | `--image ruta.png` | El primer slot `image`/`image[]`, o `--image-slot` |
| JSON o texto por pipe | `--stdin` | JSON: se mergea con `--input`; texto: va al slot de texto |

`pickTextSlot` elige, en este orden: el único slot declarado; el único slot `text`; el único slot `text` obligatorio; el slot llamado `state`. Si hay ambigüedad, usá `--slot <name>`.

`--state`, `--state-file` y `--image` se aplican **después** de `--input`, así que pisan o agregan valores.

## Escribir una receta nueva: checklist de 10 pasos

1. **Copiá** `examples/copy-checker.json` o `examples/ux-checker.json` como base.
2. **Definí `id` y `role`.** El `id` puede salir del nombre del archivo, pero es mejor declararlo.
3. **Declará los slots** en `input.slots` con el tipo correcto y `required` solo cuando sea imprescindible.
4. **Escribí `input.state`** con las plantillas `{{slot}}` y una instrucción de tarea clara. Es el único lugar con contexto dinámico.
5. **Definí los criterios**: `noul` para sí/no, `choice` para categorías, `score` para grados. Cada uno con `instructions` accionable, `passAt`, `weight`, `severity` y `remediation`.
6. **Agrupá en etapas.** Todo lo que se puede preguntar junto va en una etapa (una llamada). Lo que depende de respuestas previas va en una etapa posterior.
7. **Agregá `when`** solo si la etapa es condicional, referenciando ids ya calculados.
8. **Agregá `derived`** si necesitás un índice compuesto; se evalúa en orden y antes de `acceptance`.
9. **Agregá `acceptance`** para las condiciones duras del negocio. Sin acceptance, solo los `blocker` pueden reprobar.
10. **Validá, imprimí el request y corré**: `recipe validate`, `--print-request`, después `--json`. Probá primero con `--provider mock` para verificar el flujo.

Reglas de diseño que evitan problemas:

- Un criterio que no se pregunta en ninguna etapa genera un warning y nunca aparece en el resultado.
- No uses ids que empiecen con dígito si los vas a referenciar en expresiones sin corchetes.
- Para restar identificadores, dejá espacios: `UX-1 - 0.5`, no `UX-1-0.5`.
- No referencies un `derived` posterior desde otro `derived`: la validación no lo detecta, falla en runtime.
- Máximo 64 preguntas por etapa, 2..255 opciones de `choice`, 2..10 niveles de `score`.

## Interpretar la salida

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
| `3` | `needs_review` | Un criterio `blocker` tiene confianza baja. Escalar a revisión humana o subir evidencia/contexto y reejecutar. |

En errores con `--json`, el JSON va a **stderr** y el stdout queda vacío:

```json
{
  "ok": false,
  "error": {
    "code": "E_INPUT",
    "message": "falta el slot obligatorio \"copy\"",
    "hint": "tipo esperado: text; ejemplo: {\"copy\": \"texto\"}",
    "details": { "path": "input.copy", "expected": "text" }
  }
}
```

Códigos: `E_USAGE`, `E_VALIDATION`, `E_INPUT`, `E_CONFIG`, `E_PROVIDER`, `E_TIMEOUT`, `E_EXPR`, `E_INTERNAL`.

## Errores comunes y su fix

| Síntoma / mensaje | Causa | Fix |
| --- | --- | --- |
| `falta el slot obligatorio "X"` | La entrada no trae una clave requerida | Agregarla al JSON de `--input`, o usar `--state`/`--slot` |
| `no hay entrada para evaluar` | No se pasó nada | `--input`, `--state`, `--state-file`, `--image` o `--stdin` |
| `no se pudo determinar el slot para --state` (o `--state-file`) | Hay varios slots de texto | `--slot <name>` |
| `referencia de plantilla desconocida` | `{{...}}` apunta a algo que no existe en el state | Revisar el nombre: `{{answers.<id>.normalized}}`, `{{criteria.<id>}}`, `{{slot}}` |
| `referencia desconocida: "X"` en `when`/`derived`/`acceptance` | Id mal escrito o no declarado | Corregir el id; `recipe validate` lo detecta antes de correr |
| `referencia desconocida: "X"` en `when` de una etapa | El id existe, pero pertenece a una etapa posterior | Mover la etapa o quitar la dependencia; la validación semántica no mira el orden |
| `la etapa "X" tiene un "when" inválido` | Expresión mal formada | Ver gramática en `docs/recipe-spec.md`; ids con guiones y resta con espacios |
| `provider "X" no está configurado` | Alias inexistente | `m1 auth status` o revisar `providers` en `m1.config.json` |
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

```bash
# Ver la versión y la ayuda
pnpm m1 --version
pnpm m1 --help
pnpm m1 run --help

# Imprimir el JSON Schema de la receta
pnpm m1 recipe schema

# Validar una receta
pnpm m1 recipe validate examples/copy-checker.json
pnpm m1 recipe validate ./mi-receta.json --json

# Diagnóstico del entorno
pnpm m1 doctor
pnpm m1 doctor --json

# Ejecutar con texto
pnpm m1 run examples/copy-checker.json --state "Empezá tu prueba gratis." --json

# Ejecutar con archivo de texto
pnpm m1 run examples/copy-checker.json --state-file ./copy.txt --json

# Ejecutar con JSON de entrada
pnpm m1 run examples/copy-checker.json --input ./entrada.json --json

# Ejecutar con imagen (repetible)
pnpm m1 run examples/ux-checker.json --image ./shots/home.png --image ./shots/mobile.png --state "brief" --json

# Ejecutar con datos por stdin (PowerShell)
Get-Content ./entrada.json | pnpm m1 run examples/copy-checker.json --stdin --json
# POSIX: cat ./entrada.json | pnpm m1 run examples/copy-checker.json --stdin --json

# Ver el request sin llamar al proveedor
pnpm m1 run examples/copy-checker.json --state "texto" --print-request

# Dry-run explícito
pnpm m1 run examples/copy-checker.json --state "texto" --dry-run --trace

# Forzar proveedor y modelo
pnpm m1 run examples/copy-checker.json --state "texto" --provider mock --json
pnpm m1 run examples/copy-checker.json --state "texto" --provider cf --model @cf/cloudflare/clef --json

# Timeout por etapa
pnpm m1 run examples/copy-checker.json --state "texto" --timeout 90000 --json

# Salida compacta para consumo barato de otro LLM
pnpm m1 run examples/copy-checker.json --state "texto" --compact

# Config alternativa
pnpm m1 run examples/copy-checker.json --state "texto" -c ./m1.config.local.json --json

# Credenciales
pnpm m1 auth set cf --token <token> --account-id <account-id>
pnpm m1 auth status
pnpm m1 auth status --json
pnpm m1 auth remove cf
```

## Discrepancias detectadas

1. `src/cli/index.ts:66` promete que `auth set --env <VAR>` "indica la variable de entorno a usar", pero `src/cli/commands/auth.ts:16-25` no escribe config ni credenciales: solo imprime un mensaje y sale con 0. Hay que configurar `apiKeyEnv` a mano en `m1.config.json`.
2. `src/cli/commands/run.ts:141`: con `--dry-run` o `--print-request` el exit code siempre es 0, aunque el veredicto interno sea `fail`.
3. `--print-request` imprime todas las etapas, incluso las que un `when` saltearía en una corrida real (`src/core/engine.ts:137-179`).
4. `src/cli/index.ts:28`: `--timeout` es por etapa, no un timeout total del run.
5. `src/config/credentials.ts:61`: el `accountId` cae a `CLOUDFLARE_ACCOUNT_ID` para cualquier provider, no solo Cloudflare.
