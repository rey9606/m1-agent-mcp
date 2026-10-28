# Especificación de workflow v1 (`m1agent/recipe@1`)

Referencia del formato que consume el motor. Fuente de verdad: `src/schema/recipe.ts` (esquema zod) y `src/core/validate.ts` (reglas semánticas). El JSON Schema se puede imprimir con `m1 workflow schema`.

## Estructura general

```json
{
  "schema": "m1agent/recipe@1",
  "id": "copy-checker",
  "role": "Editor de copy",
  "description": "...",
  "whenToUse": "...",
  "provider": "cf",
  "input": { "slots": {}, "state": {}, "images": [] },
  "criteria": [],
  "stages": [],
  "derived": [],
  "acceptance": [],
  "outputs": ["verdict", "score", "criteria", "issues"],
  "limits": {}
}
```

## Campos de nivel superior

| Campo | Tipo | Obligatorio | Default | Reglas |
| --- | --- | --- | --- | --- |
| `schema` | string | no | — | Si está, debe ser exactamente `"m1agent/recipe@1"`. |
| `id` | string | no | derivado del nombre del archivo | Si falta, `validateRecipe` usa el basename sin `.json`. Si no hay de dónde derivarlo, error. |
| `role` | string | **sí** | — | No vacío. Describe el rol del agente. |
| `description` | string | no | — | Texto libre. |
| `whenToUse` | string | no | — | Texto libre, orientativo. |
| `provider` | string | no | — | Alias del provider en la config. `run` lo usa cuando no se pasa `--provider`; `--provider` tiene prioridad. |
| `input` | objeto | no | `{ "slots": {}, "images": [] }` | Ver [input](#input). |
| `criteria` | array | **sí** | — | Mínimo 1. Ver [criterios](#criterios). |
| `stages` | array | **sí** | — | Mínimo 1. Ver [etapas](#etapas). |
| `derived` | array | no | `[]` | Ver [derived](#derived). |
| `acceptance` | array | no | `[]` | Ver [acceptance](#acceptance). |
| `outputs` | array de strings | no | `["verdict","score","criteria","issues"]` | Declarado, pero ningún renderer lo consume: la salida es fija. |
| `limits` | objeto | no | `{}` | Ver [limits](#limits). |

## Input

```json
"input": {
  "slots": {
    "brief":   { "type": "text", "required": false, "description": "Contexto" },
    "screens": { "type": "image[]", "required": true, "max": 4 }
  },
  "state": { "brief": "{{brief}}", "tarea": "..." },
  "images": ["screens"]
}
```

### `slots`

| Campo | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `type` | `"text" \| "json" \| "image" \| "image[]"` | — | Obligatorio. |
| `required` | boolean | `false` | Si falta y es `true`: `E_INPUT`. |
| `description` | string | — | Texto libre; no se envía al modelo. |
| `max` | entero | `4` | Solo para `image[]`. Rango 1..4 (tope duro de la API). |

Comportamiento en runtime (`src/intake/input.ts`):

- `text`: debe ser string no vacío (se rechazan strings de solo espacios).
- `json`: acepta cualquier valor JSON.
- `image`: acepta un path local, una data URL `data:image/png;base64,...` o `{ content_type?, base64 }`.
- `image[]`: array de 1..`max` elementos con las mismas formas que `image`.
- Slot opcional ausente: `text` → `""`, `image[]` → `[]`, `json`/`image` → `null`. Así las plantillas `{{slot}}` siempre resuelven.
- Las claves de entrada no declaradas se conservan en `vars` y quedan disponibles para plantillas y expresiones.

### `state`

Plantilla del contexto que se envía al proveedor. Si se omite, el state es el mapa plano de variables primitivas (`string`, `number`, `boolean`) del input. Puede ser cualquier valor JSON con strings que contengan `{{...}}`; se renderiza antes de cada etapa.

### `images`

Nombres de slots de imagen que se envían por defecto. Se valida que existan y que sean de tipo `image` o `image[]`.

## Criterios

| Campo | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `id` | string | — | Regex `^[A-Za-z0-9_.-]{1,100}$`. Es la clave de la pregunta y de la respuesta. Único en la receta. |
| `name` | string | — | Etiqueta para humanos. |
| `type` | `"noul" \| "choice" \| "score"` | — | Obligatorio. |
| `instructions` | string | — | No vacío. Es el texto que ve el modelo. Estático: no admite plantillas. |
| `criteria` | según tipo | — | `choice`: objeto `id → descripción` con 2..255 claves. `score`: array ordenado de 2..10 niveles (menor primero). `noul`: opcional `{ "true"?: desc, "false"?: desc }`. |
| `polarity` | `"positive" \| "negative"` | `"positive"` | `negative` invierte el valor normalizado (`1 - x`). |
| `passAt` | number | `0.5` | Rango 0..1. Umbral de `passed`. Se usa `>=`. |
| `weight` | number | `1` | `>= 0`. `0` = informativo: no suma al score. |
| `severity` | `"blocker" \| "major" \| "minor" \| "info"` | `"major"` | Afecta issues y, para `blocker`, el veredicto. |
| `remediation` | string | — | Texto accionable; se copia al issue cuando el criterio falla. |
| `mapping` | objeto | — | Solo `choice`: valor 0..1 por opción. Las claves deben existir en `criteria`. |

Validaciones de `mapping`/`criteria` (`src/schema/recipe.ts:73-104`):

- `score` sin array o con menos de 2 / más de 10 niveles: error.
- `choice` sin objeto o con menos de 2 / más de 255 opciones: error.
- `mapping` con una clave que no existe entre las opciones: error.
- `noul` con `criteria` que no sea objeto (o sea array): error.

No se validan ids duplicados dentro de `stages[].questions`; si se repiten, el criterio se pregunta una sola vez en el request pero se normaliza y agrega más de una vez.

## Etapas

```json
"stages": [
  { "id": "base", "questions": ["CP-1", "CP-2", "CP-3"] },
  {
    "id": "diagnostico",
    "when": "CP-2 < 0.6",
    "questions": ["CP-6"],
    "state": { "hallazgos": { "tono": "{{answers.CP-2.choice}}" } },
    "images": ["screens"]
  }
]
```

| Campo | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `id` | string | — | No vacío. Se usa en `trace` y en los mensajes de error. |
| `questions` | array de strings | — | 1..64 ids de criterios existentes. Tope duro de la API. |
| `when` | string | — | Expresión. Si es falsa, la etapa se saltea sin llamar al proveedor. |
| `state` | plantilla | `input.state` | Si falta, se usa el state de la receta. `{}` es un override válido. |
| `images` | array de strings | `input.images` | Slots de imagen para esta etapa. `[]` desactiva las imágenes. |

Semántica de ejecución (`src/core/engine.ts`):

1. Se evalúa `when` contra el scope acumulado (criterios y derived ya calculados).
2. Se renderiza `state` con `vars + answers + criteria`.
3. Se cargan las imágenes de los slots indicados y se valida el presupuesto global.
4. Se arma **un** request con todas las preguntas de la etapa (`questions` en un mapa `id → pregunta`).
5. Se llama al proveedor una vez. Las N preguntas viajan juntas; el paralelismo es interno del proveedor.
6. Se normaliza cada respuesta y se agrega al scope para las etapas siguientes.

Consecuencias:

- Una etapa cuesta una llamada, sin importar cuántas preguntas tenga (hasta 64).
- Las etapas son secuenciales: una etapa posterior puede depender de las respuestas anteriores.
- Las imágenes se envían por etapa; si dos etapas declaran los mismos slots, se envían dos veces.
- Sumar imágenes de varios slots puede superar el máximo de 4 por request: el motor falla con `E_INPUT` antes de llamar.
- En `--dry-run` no se evalúa `when` y se usan respuestas neutras (`0.5`, primera opción) para poder renderizar plantillas. Ver [docs/for-agents.md](for-agents.md).

## Derived

| Campo | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `id` | string | — | Regex `^[A-Za-z0-9_.-]{1,100}$`. Único y sin colisión con ids de criterio. |
| `expr` | string | — | Expresión válida. |
| `description` | string | — | Texto libre. |

Se evalúan **en orden de declaración**, después de todas las etapas y antes de `acceptance`. El resultado se convierte a número (`boolean` → 1/0; string numérica → número; no numérica → 0) y se guarda en `result.derived`. Un derived puede referenciar criterios y derived anteriores; referenciar uno posterior falla en runtime con `E_EXPR` (`src/core/engine.ts:330-348`).

## Acceptance

| Campo | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `id` | string | — | No vacío. Único. No puede colisionar con un id de criterio. |
| `expr` | string | — | Expresión válida; cualquier resultado truthy cuenta como `passed`. |
| `severity` | severidad | `"major"` | `blocker`/`major` fallado → `fail`; `minor`/`info` fallado → `needs_review`. |

## Limits

| Campo | Tipo | Default | Reglas |
| --- | --- | --- | --- |
| `maxStages` | entero | 64 | 1..64 en el esquema; `validateRecipe` usa 64 si no se declara. |
| `timeoutMs` | entero | 60000 | Timeout por llamada al proveedor. |
| `minConfidence` | number | 0.6 | 0..1. Si un criterio `blocker` con confianza definida queda por debajo, el veredicto es `needs_review`. |

## Validación semántica

`validateRecipe` (`src/core/validate.ts`) junta todos los problemas antes de fallar. Además del esquema:

- `id` de criterio duplicado.
- `derived` duplicado o que colisiona con un criterio.
- `acceptance` duplicado o que colisiona con un criterio.
- Más etapas que `limits.maxStages`.
- `stages[].questions` con un id inexistente.
- `when` que no parsea o referencia un valor inexistente (criterios o derived).
- `input.images` o `stages[].images` que referencian slots inexistentes o que no son de imagen.
- `derived[].expr` y `acceptance[].expr` que no parsean o referencian valores inexistentes.
- **Warning** (no error): criterio que no se pregunta en ninguna etapa.

Las referencias con sufijo se aceptan: `UX-1.normalized`, `UX-1.choice`, `UX-1.confidence`. Los literales `true`, `false`, `null`, `undefined` se ignoran en el chequeo de referencias.

## Expresiones

Se usan en `stages[].when`, `derived[].expr` y `acceptance[].expr`. Parser propio en `src/core/expr.ts`; no hay `eval` ni `Function`.

### Gramática real

```text
expr        := or
or          := and ( "||" and )*
and         := equality ( "&&" equality )*
equality    := comparison ( ("==" | "!=") comparison )*
comparison  := additive ( (">" | ">=" | "<" | "<=") additive )*
additive    := multiplicative ( ("+" | "-") multiplicative )*
multiplicative := unary ( ("*" | "/" | "%") unary )*
unary       := ("!" | "-") unary | primary
primary     := number | string | "true" | "false" | "null" | ident | "(" expr ")"
ident       := [A-Za-z_][A-Za-z0-9_.-]* | "[" <texto> "]" ( "." parte | "[" <texto> "]" | parte )*
```

- Precedencia, de menor a mayor: `||`, `&&`, `==`/`!=`, comparaciones, `+`/`-`, `*`/`/`/`%`, unarios, primario.
- Asociatividad: todo a la izquierda.
- `true`, `false`, `null` son literales (en minúscula).
- Números: enteros o decimales con punto (`0`, `0.75`). No hay exponente ni signo dentro del literal (el signo es el unario `-`).
- Strings: comillas simples o dobles. Escapes admitidos: `\"`, `\'`, `\\`, `\n`, `\t`.
- Paréntesis: `(` `)`.

### Identificadores

- Un identificador que empieza con letra o `_` consume todo `[A-Za-z0-9_.-]*`. Por eso `UX-1` es **un** identificador y `UX-1.normalized` también.
- Consecuencia: la resta entre identificadores necesita espacios. `UX-1 - 1` funciona; `UX-1-1` es el identificador `UX-1-1` y falla por referencia desconocida.
- Los corchetes escapan cualquier id: `[UX-1]`, `[UX-1].normalized`, `[mi.id]`.
- Un id que empieza con dígito o punto (permitido por el esquema de criterios) debe escribirse entre corchetes en expresiones.
- La resolución busca primero la clave exacta en el scope y, si no existe, recorre el path por puntos. Las claves disponibles se reportan en el error.

### Valores y coerciones

- `==`/`!=`: comparan estricto, salvo número contra string numérica (`score == "0.75"` se coerciona).
- `>`/`>=`/`<`/`<=`: número con número, string con string (lexicográfico), o número con string numérica. Booleanos y `null` con orden producen `E_EXPR`.
- `+`, `-`, `*`, `/`, `%`: exigen números (o strings numéricas). División o módulo por cero produce `E_EXPR`.
- `&&`/`||`: cortocircuitan y devuelven boolean.
- Truthiness: `null` → falso; número → distinto de 0 y no `NaN`; string → no vacío; boolean → su valor.
- El resultado de una expresión debe ser número, string o boolean. `null` se interpreta como `false`.

### Errores

Todo error de sintaxis, referencia desconocida o tipo inválido es `E_EXPR`, con posición y, cuando aplica, lista de claves disponibles. Una expresión inválida en `when` corta el run con `E_EXPR` (la etapa se marca `error` en el trace).

## Plantillas `{{...}}`

Solo se renderizan en `state` (`recipe.input.state` y `stages[].state`). No se aplican a `instructions` ni a otros campos de la receta. Implementación: `src/core/template.ts`.

### Scope disponible

| Path | Contenido |
| --- | --- |
| `{{slot}}` | Valor del slot tal como se resolvió (`text`, `json`, `image`/`image[]` no aportan un valor útil en plantillas). |
| `{{otraClave}}` | Claves de entrada no declaradas como slot. |
| `{{answers.<id>.<prop>}}` | Respuesta rica del criterio: `type`, `raw`, `normalized`, `passed`, más `choice`, `probabilities`, `confidence`, `noul`, `score`, `legend` según lo devuelto. |
| `{{criteria.<id>}}` | Valor normalizado del criterio (0..1). |
| `{{criteria.<id>.normalized}}` | Igual que el anterior. |
| `{{criteria.<id>.choice}}` | Opción elegida (string), para `choice`. |
| `{{criteria.<id>.confidence}}` | Confianza, si existe. |

Propiedades reales de `answers`, según el motor (`src/core/engine.ts:286-291`): se copia la respuesta del proveedor y se sobrescriben `raw`, `normalized`, `passAt` y `passed`. Por eso `answers.CP-2.choice`, `answers.CP-1.normalized`, `answers.UX-1.confidence` y `answers.X.passAt` funcionan.

### Reglas de resolución

- Si el string es exactamente `{{path}}`, se devuelve el valor tal cual (objetos, arrays y números conservan su tipo).
- Si `{{path}}` está embebido, se interpola como string; objetos y arrays se serializan con `JSON.stringify`. Un valor `null` embebido se interpola como `"null"` (por ejemplo, un slot `json` ausente en `{{logs}}`).
- Los segmentos se separan por puntos; `[...]` permite ids con puntos o cualquier carácter. Ejemplo: `{{answers.[UX-1].choice}}`.
- Si un path no existe, `E_EXPR` con las claves disponibles.
- Los objetos y arrays se recorren en profundidad; no se muta la entrada.

## Normalización y veredicto

### Normalización por tipo

| Tipo | `raw` | `normalized` | `confidence` |
| --- | --- | --- | --- |
| `noul` | `clamp01(answer.noul)` | `polarity === "negative" ? 1 - raw : raw` | no existe |
| `choice` | `answer.choice` (string) | `base = mapping[choice] ?? probabilities[choice] ?? 0`; si `negative`, `1 - base` | `answer.confidence` |
| `score` | `answer.score` | `clamp01(score / (niveles - 1))`; si `negative`, `1 - normalized` | `answer.confidence` |

`passed = normalized >= passAt` (`passAt` default 0.5). `normalized` siempre queda en 0..1: `noul` y `score` se clampean; `mapping` está restringido a 0..1 por el esquema, pero `probabilities` se usa tal como lo devuelva el proveedor.

Si el proveedor devuelve un tipo distinto al declarado, o no devuelve respuesta para un id, el run falla con `E_PROVIDER`.

### Score

`score` es un entero 0..100:

```text
score = round( sum(normalized_i * weight_i) / sum(weight_i) * 100 )
```

Solo suman los criterios con `weight > 0`. Si la suma de pesos es 0, el score es 0.

### Issues

Se emite un issue por cada criterio con `passed === false`, ordenados por severidad (`blocker`, `major`, `minor`, `info`) y luego por id. El mensaje incluye el `raw` formateado y el umbral. Cada issue copia `remediation` si existe.

### Orden de `decideVerdict`

1. Si algún `acceptance` `blocker` o `major` falló → `fail`.
2. Si algún criterio `blocker` falló → `fail`.
3. Si algún `acceptance` `minor` o `info` falló → `needs_review`.
4. Si algún criterio `blocker` con `confidence` definida tiene `confidence < minConfidence` → `needs_review`.
5. En cualquier otro caso → `pass`.

Consecuencias:

- `acceptance` con severidad `blocker`/`major` es un gate duro; `minor`/`info` degrada a `needs_review` sin reprobar.
- Un criterio `blocker` fallado produce `fail` aunque exista `acceptance`.
- Un criterio no-`blocker` puede fallar y aun así el veredicto ser `pass`.
- `needs_review` gana sobre `pass`, pero pierde contra `fail`.
- `minConfidence` sale de `limits.minConfidence` (default 0.6). Solo aplica a criterios con confianza: `choice` y `score`.

## Ejemplos

### Receta de una etapa

```json
{
  "schema": "m1agent/recipe@1",
  "id": "release-notes",
  "role": "Editor de release notes",
  "input": {
    "slots": {
      "notes": { "type": "text", "required": true }
    },
    "state": { "notas": "{{notes}}" },
    "images": []
  },
  "criteria": [
    {
      "id": "RN-1",
      "name": "Claridad",
      "type": "score",
      "instructions": "¿Qué tan claro es el cambio para alguien que no participó del desarrollo?",
      "criteria": ["Opaco", "Parcial", "Claro"],
      "polarity": "positive",
      "passAt": 0.5,
      "weight": 1,
      "severity": "major",
      "remediation": "Explicá qué cambió y por qué le importa a quien usa el producto."
    }
  ],
  "stages": [
    { "id": "base", "questions": ["RN-1"] }
  ],
  "acceptance": [
    { "id": "A1", "expr": "RN-1 >= 0.5", "severity": "major" }
  ],
  "limits": { "timeoutMs": 60000, "minConfidence": 0.6 }
}
```

### Receta de dos etapas con `when`

```json
{
  "schema": "m1agent/recipe@1",
  "id": "bug-triage",
  "role": "Triador de bugs",
  "input": {
    "slots": {
      "report": { "type": "text", "required": true },
      "logs": { "type": "json", "required": false }
    },
    "state": { "reporte": "{{report}}", "logs": "{{logs}}" },
    "images": []
  },
  "criteria": [
    {
      "id": "BT-1",
      "name": "Reproducibilidad",
      "type": "noul",
      "instructions": "El reporte describe pasos concretos y reproducibles.",
      "criteria": { "true": "Pasos claros.", "false": "Faltan pasos o son ambiguos." },
      "passAt": 0.6,
      "weight": 0.4,
      "severity": "blocker",
      "remediation": "Pedí pasos numerados, resultado esperado y resultado observado."
    },
    {
      "id": "BT-2",
      "name": "Impacto",
      "type": "score",
      "instructions": "¿Cuánto bloquea el uso normal del producto?",
      "criteria": ["Cosmético", "Molesto", "Bloqueante"],
      "passAt": 0.5,
      "weight": 0.6,
      "severity": "major",
      "remediation": "Priorizá según impacto real en el flujo principal."
    },
    {
      "id": "BT-3",
      "name": "Área probable",
      "type": "choice",
      "instructions": "¿En qué área conviene investigar primero?",
      "criteria": { "ui": "Interfaz", "api": "API", "datos": "Datos" },
      "mapping": { "ui": 0.5, "api": 0.7, "datos": 0.6 },
      "passAt": 0.5,
      "weight": 0,
      "severity": "info",
      "remediation": "Asigná el bug al área indicada y adjuntá el diagnóstico."
    }
  ],
  "stages": [
    { "id": "triaje", "questions": ["BT-1", "BT-2"] },
    {
      "id": "area",
      "when": "BT-1 < 0.6",
      "questions": ["BT-3"],
      "state": {
        "reporte": "{{report}}",
        "reproducibilidad": "{{answers.BT-1.normalized}}",
        "impacto": "{{answers.BT-2.normalized}}"
      }
    }
  ],
  "derived": [
    { "id": "riesgo", "expr": "BT-1*0.4 + BT-2*0.6", "description": "Riesgo operativo (0..1)." }
  ],
  "acceptance": [
    { "id": "A1", "expr": "BT-1 >= 0.6", "severity": "major" },
    { "id": "A2", "expr": "riesgo >= 0.6", "severity": "minor" }
  ],
  "limits": { "maxStages": 4, "timeoutMs": 60000, "minConfidence": 0.6 }
}
```

Ambas pasan `m1 workflow validate`.

## Discrepancias detectadas

1. `src/schema/recipe.ts:164`: `outputs` existe en el esquema pero los renderers no lo usan; la salida siempre incluye todos los campos.
2. En `--dry-run`/`--print-request` no se evalúa `when` y se siembran respuestas neutras (`src/core/engine.ts:137-179`), por lo que el request impreso puede no coincidir con el de una corrida real.
