# Contrato de API: Clef (Cloudflare), JEV (TypeSafe) y OpenRouter

Contrato tal como lo implementa el repo (`src/providers/`). No reemplaza la documentación oficial de cada proveedor: describe lo que el motor envía y lo que acepta de vuelta. Cualquier endpoint que cumpla este contrato puede usarse como `kind: "systemone"` sin escribir código.

## Forma común del request

```http
POST <url>
Content-Type: application/json
Authorization: Bearer <api-key>

{
  "model": "clef-flash",
  "state": { "tarea": "...", "copy": "..." },
  "questions": {
    "CP-1": {
      "type": "score",
      "instructions": "¿Qué tan claro es el mensaje?",
      "criteria": ["Confuso", "Mejorable", "Claro", "Cristalino"]
    },
    "CP-2": {
      "type": "choice",
      "instructions": "¿Cómo suena el tono?",
      "criteria": { "on_brand": "Alineado", "off_brand": "Choca" }
    },
    "CP-3": {
      "type": "noul",
      "instructions": "El texto tiene un CTA único.",
      "criteria": { "true": "Sí", "false": "No" }
    }
  },
  "images": [
    { "content_type": "image/png", "base64": "iVBORw0KGgo..." }
  ]
}
```

| Campo | Tipo | Obligatorio | Notas |
| --- | --- | --- | --- |
| `model` | string | sí | El modelo que el endpoint espera. En Cloudflare se deriva a `clef` o `clef-flash`. |
| `state` | cualquier JSON | sí | Contexto renderizado por el motor. Puede ser objeto, array o escalar. |
| `questions` | objeto `id → pregunta` | sí | Mapa, no array. Las claves son los ids de criterio. |
| `images` | array | no | Se omite si no hay imágenes. `content_type` + `base64` crudo (sin prefijo `data:`). |

### Preguntas

| `type` | `criteria` | Semántica |
| --- | --- | --- |
| `noul` | opcional `{ true?: any, false?: any }` | Probabilidad de que la afirmación sea verdadera. |
| `choice` | objeto `id → descripción` (2..255) | El modelo elige una opción y devuelve probabilidades. |
| `score` | array ordenado de 2..10 niveles | El modelo devuelve una posición ponderada 0..niveles-1; puede ser fraccionaria (ej. `0.67`). |

## Cloudflare (Clef)

| Dato | Valor |
| --- | --- |
| URL | `https://api.cloudflare.com/client/v4/accounts/<accountId>/ai/run/@cf/cloudflare/<modelo>` |
| `modelo` | `clef` o `clef-flash` |
| Auth | `Authorization: Bearer <CLOUDFLARE_API_TOKEN>` |
| `accountId` | `provider.accountId` o `CLOUDFLARE_ACCOUNT_ID` |
| Modelo por defecto | `@cf/cloudflare/clef-flash` |
| Timeout por defecto | 60 s |
| Imágenes | Sí |

Detalles de implementación (`src/providers/cloudflare.ts`):

- El `model` de la config acepta `clef`, `clef-flash`, `@cf/cloudflare/clef` o `@cf/cloudflare/clef-flash`. Cualquier otro valor produce `E_CONFIG` antes de llamar.
- El `accountId` se interpola con `encodeURIComponent`.
- El body repite `model` además de ir en la URL.
- `cfg.headers` se aplica primero; luego el provider fija `Content-Type` y `Authorization`, así que un header personalizado con esos nombres queda pisado.
- La respuesta se desenvuelve antes de validarla: si el JSON raíz tiene `answers`, se usa tal cual; si tiene `result` objeto, se usa `result`; si no, se usa el JSON completo.

## TypeSafe (JEV)

| Dato | Valor |
| --- | --- |
| URL | `https://api.typesafe.ai/v1/systemone` (override con `provider.baseUrl`) |
| Auth | `Authorization: Bearer <TYPESAFE_API_KEY>` |
| Modelo por defecto | `jev-latest` |
| Timeout por defecto | 60 s |
| Imágenes | **No** |

Detalles (`src/providers/typesafe.ts`):

- Body: `{ model, state, questions }`; nunca incluye `images`.
- Si la receta resuelve imágenes para una etapa, falla con `E_PROVIDER` ("JEV no soporta imágenes") antes de hacer la llamada. No las descarta silenciosamente.
- Mismo mecanismo de unwrap y de validación de respuesta que Cloudflare.

## OpenRouter (modelos de decisión)

| Dato | Valor |
| --- | --- |
| URL | `https://openrouter.ai/api/v1/systemone` (override con `provider.baseUrl`) |
| Auth | `Authorization: Bearer <OPENROUTER_KEY>` |
| Modelo por defecto | `typesafe/jev-1.14` |
| Timeout por defecto | 60 s |
| Imágenes | Sí, según el modelo (los `:free` actuales son sólo texto) |
| Catálogo | `GET https://openrouter.ai/api/v1/models?output_modalities=decisions` |

Detalles (`src/providers/openrouter.ts`):

- Usa la superficie System One (`/systemone`), no `chat/completions`: mismo body `{ model, state, questions }` y misma respuesta `{ answers, usage, model }`.
- La key se resuelve con `provider.apiKey` > `provider.apiKeyEnv` > `OPENROUTER_KEY` > `credentials.json` (el merge final lo hace la CLI).
- **Las imágenes no van en un campo `images` de nivel superior** (OpenRouter responde 400). Se insertan en `state` como partes:

  ```json
  {
    "model": "typesafe/jev-1.14",
    "state": [
      "texto del state",
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
    ],
    "questions": { "q1": { "type": "noul", "instructions": "..." } }
  }
  ```

  Si `state` es string, se envuelve en `[state, ...imágenes]`; si es array, se hace append; si es objeto, la CLI falla con `E_CONFIG` antes de llamar (no se puede preservar la semántica del objeto).
- `m1 models --provider or` lista el catálogo vivo y cae al catálogo estático si la API no responde (403/red). `--free` filtra a los publicados sin costo.
- Ids válidos: `author/slug`, alias `~author/slug` y variantes `:free` (ej. `typesafe/jev-1.14`, `~typesafe/jev-latest`, `baseten/mammoth-1:free`).
- Los modelos `:free` comparten cuota y rate limits más estrictos que los pagos. `402` indica falta de créditos para un modelo pago.

## SystemOne (endpoint compatible)

| Dato | Valor |
| --- | --- |
| URL | `provider.baseUrl` (obligatoria, URL completa del endpoint) |
| Auth | `Authorization: Bearer <key>` solo si hay key |
| Modelo por defecto | `local-decision` (override con `provider.model` o `--model`) |
| Timeout por defecto | 60 s |
| Imágenes | Sí: `{ content_type, base64 }` por defecto, o data URLs con `provider.imageFormat: "dataUrl"` (llama.cpp) |

Es el adaptador genérico: mismo body, misma respuesta, `baseUrl` configurable y autenticación opcional. Se usa para servidores locales, proxies o cualquier implementación propia del contrato.

```json
{
  "providers": {
    "local": {
      "kind": "systemone",
      "baseUrl": "http://localhost:8000/v1/systemone",
      "model": "clef-flash",
      "apiKeyEnv": "LOCAL_API_KEY",
      "unwrap": "auto"
    }
  }
}
```

### llama.cpp (modelo local)

`llama-server` implementa la misma superficie en `POST /v1/systemone` para modelos de decisión nativos (los que publican `architecture.output_modalities: ["decisions"]` en `GET /v1/models`). No requiere API key.

| Dato | Valor |
| --- | --- |
| Endpoint | `http://127.0.0.1:<port>/v1/systemone` |
| Health | `GET /health` → `200` listo, `503` cargando el modelo |
| Catálogo | `GET /v1/models` (el id es el `--alias`, o el path del GGUF) |
| Auth | No |
| Modelos Liquid | `LiquidAI/d1-2B-GGUF` (`d1-2B`), `d1-3B-GGUF`, `d1-Omni-2B-GGUF`, `d1-omni-600M-GGUF` |

Comando mínimo (el alias fija el id que ve `m1`):

```bash
llama-server -hf LiquidAI/d1-2B-GGUF:Q8_0 -b 8192 -ub 8192 --alias d1-2B --port 9931
```

`launch` en la config le permite a `m1` hacer eso por vos:

```json
"liquid": {
  "kind": "systemone",
  "baseUrl": "http://127.0.0.1:9931/v1/systemone",
  "model": "d1-2B",
  "unwrap": "auto",
  "imageFormat": "dataUrl",
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

Comportamiento del ciclo de vida (`src/local/lifecycle.ts`):

- Sondea `/health` con timeout corto. Si responde, no arranca nada.
- Si el puerto preferido está ocupado por otro proceso, busca el siguiente libre (hasta 50) y reescribe `baseUrl` en memoria.
- `autoStart: always` (default) arranca sin preguntar; `ask` sólo pregunta si `stdin` y `stderr` son TTY; `never` falla con el comando exacto. `--local-start` lo overridea y en `--json` nunca hay prompt.
- **El servidor no se apaga al terminar el run**: queda para los siguientes (el modelo ya está cargado) y lo apaga el usuario con `m1 local stop` o cerrando su consola.
- En Windows, `console: true` (default) abre una consola minimizada vía `start` + WMI, fuera del job de `pnpm`/`tsx`. Al cerrar la ventana muere el servidor. Se agregan `--log-file <log>` y `--log-colors off` (si no estaban) para que el log no se pierda ni traiga ANSI. Con `console: false` el proceso queda detached y oculto.
- El registro (`pid`, `port`, `baseUrl`, `logPath`) queda en `~/.cache/m1-agent/local/<alias>.json`. En modo consola el PID se descubre por el puerto (`netstat -ano`).
- `m1 local start` verifica y levanta si hace falta (idempotente); `m1 local status` sondea sin arrancar; `m1 local stop` mata el árbol del PID registrado (`taskkill /T /F` en Windows).

Límites del modelo (llama.cpp):

- `state` puede ser `null` para preguntar sólo sobre imágenes (d1-2B/d1-omni).
- d1-2B evalúa cada pregunta en un batch: `-b`/`-ub` deben contener el state y los medios; una imagen usa como máximo la mitad de `-ub` (8192 → 4096 tokens por imagen).
- `lfm2-d1-omni` corta el prompt a 16.384 tokens y también exige que entre en `--ubatch-size`.
- Imágenes: requieren `--mmproj`; sin proyector, el endpoint responde `501`. Audio (d1-Omni) también requiere proyector.
- llama.cpp exige `images` como data URLs (`data:image/png;base64,...`): usá `provider.imageFormat: "dataUrl"`. Además, `-b`/`-ub` deben cubrir los tokens de la imagen (una captura de 900×600 ≈ 1.8k tokens); con el default de 512 el servidor responde `500`.
- **Una tarea por pregunta:** `/v1/systemone` procesa cada pregunta como un task independiente y **re-codifica los medios en cada uno**. Una etapa de 4 preguntas sobre una imagen cuesta ~4× una de 1. Medido con d1-omni-600M Q8_0 en CPU: 384×384 + 4 preguntas ≈ 9 s; 900×600 + 4 preguntas ≈ 108 s (más el `diagnostico`: 130 s). Por eso en recetas multimodales conviene `provider.timeoutMs`/`--timeout` de 300000.
- **Tokens de imagen medidos** (misma build, texto aparte: 55 tokens): 384×384 ≈ 144; 512×512 ≈ 246; 1024×1024 ≈ 1.270; 1920×1080 ≈ 2.290. Escalan con el área, con tiling de 512×512 + thumbnail para frames grandes (LFM2.5-VL); no hay tope de resolución propio, el tope es el contexto.
- **Contexto:** el modelo está entrenado a 16.384 tokens (texto + imágenes + audio) y con imágenes el texto se recorta a 896. El GGUF declara `lfm2.context_length = 128000`, así que `llama-server` asigna 128k y **no rechaza** prompts de más de 16k: el límite es de calidad/entrenamiento, no del servidor.
- Errores: `400` request inválido; `501` modelo que no es de decisión o imágenes sin proyector.

## Respuesta

```json
{
  "model": "clef-flash",
  "answers": {
    "CP-1": { "type": "score", "score": 3, "probabilities": { "0": 0.01, "1": 0.05, "2": 0.12, "3": 0.82 }, "confidence": 0.82, "legend": {} },
    "CP-2": { "type": "choice", "choice": "on_brand", "probabilities": { "on_brand": 0.78, "off_brand": 0.22 }, "confidence": 0.78 },
    "CP-3": { "type": "noul", "noul": 0.91 }
  },
  "usage": { "input_tokens": 812, "output_tokens": 0 }
}
```

| Campo | Obligatorio | Uso |
| --- | --- | --- |
| `answers` | **sí** | Objeto `id → respuesta`. Si falta, `E_PROVIDER`. El motor exige una respuesta por cada pregunta de la etapa. |
| `model` | no | Si falta, se usa el modelo solicitado. |
| `usage` | no | `input_tokens`/`output_tokens` se acumulan en `meta` y en `trace`. |
| `result` | no | Envoltura opcional; se desenvuelve según `unwrap`. |

### Formas de respuesta por tipo

```json
{ "type": "noul",   "noul": 0.91 }
{ "type": "choice", "choice": "on_brand", "probabilities": { "on_brand": 0.78 }, "confidence": 0.78 }
{ "type": "score",  "score": 3, "probabilities": { "3": 0.82 }, "confidence": 0.82, "legend": {} }
```

- `noul`: número 0..1 (el motor lo clampea).
- `choice`: `choice` debe ser una de las claves de `criteria`. `probabilities` es necesario si el criterio no define `mapping`: el motor lo consulta como fallback. `confidence` alimenta `needs_review`.
- `score`: número entre 0 y (niveles-1); puede ser fraccionario (posición ponderada por probabilidades). `probabilities` y `legend` son opcionales. `confidence` alimenta `needs_review`.
- `type` debe coincidir con el tipo declarado en la receta; si no, `E_PROVIDER`.

### Unwrap de `{ result }`

| `unwrap` | Comportamiento |
| --- | --- |
| `auto` (default) | Si la raíz tiene `answers`, no desenvuelve. Si `result` es un objeto, devuelve `result`. Si no, devuelve la raíz. |
| `result` | Exige `result`; si falta, `E_PROVIDER`. |
| `none` | No desenvuelve; la raíz debe tener `answers`. |

`auto` cubre tanto una respuesta plana como la envoltura típica de Cloudflare (`{ "result": { "answers": ... }, "success": true }`) y de varios proxies.

## Imágenes

- Formato en el body: `{ "content_type": "image/png", "base64": "<datos>" }`. No se envía el prefijo `data:`.
- OpenRouter es la excepción: el provider las convierte a partes `{ "type": "image_url", "image_url": { "url": "data:<content_type>;base64,<datos>" } }` dentro de `state` (ver sección OpenRouter).
- Tipos aceptados por la CLI: PNG, JPEG y WebP, detectados por magic bytes. Un `content_type` declarado que no coincide con el contenido produce `E_INPUT`.
- El `base64` se genera desde el archivo o se toma de la entrada; el motor estima el body como `bytes_decodificados * 4/3 + JSON(vars)` y lo compara contra el tope de 13 MiB.

## Errores HTTP

`postDecisionJson` (`src/providers/cloudflare.ts`) centraliza el manejo:

| Situación | Código | Detalle |
| --- | --- | --- |
| Timeout o abort | `E_TIMEOUT` | `timeout tras Nms`; subir `timeoutMs`/`--timeout` |
| Error de red / DNS / URL | `E_PROVIDER` | `error de red` + mensaje |
| HTTP non-2xx | `E_PROVIDER` | `<Provider> <status>`; `details` = primeros 500 caracteres del body |
| Body vacío | `E_PROVIDER` | `respuesta vacía` |
| Body no JSON | `E_PROVIDER` | `respuesta JSON inválida` |
| Sin `answers` | `E_PROVIDER` | Sugiere revisar modelo/endpoint o `unwrap` |

Hints por status:

| Status | Cloudflare | TypeSafe | OpenRouter | SystemOne |
| --- | --- | --- | --- | --- |
| 400 | — | — | modelo o formato de `state`/imágenes inválido | — |
| 401/403 | token inválido o sin permiso de Workers AI | API key inválida o sin permisos | `OPENROUTER_KEY` inválida o sin permisos | el endpoint rechazó las credenciales |
| 402 | — | — | la cuenta no tiene créditos para ese modelo | — |
| 404 | accountId o modelo no habilitado | — | — | revisar `baseUrl` |
| 429 | rate limit: esperar o bajar concurrencia | rate limit | rate limit (los `:free` son más limitados) | rate limit del endpoint |

## Límites y costos

### Límites del contrato (aplicados por el código)

| Límite | Valor | Archivo |
| --- | --- | --- |
| Preguntas por request | 64 | `src/schema/recipe.ts` |
| Opciones de `choice` | 2..255 | `src/schema/recipe.ts` |
| Niveles de `score` | 2..10 | `src/schema/recipe.ts` |
| Imágenes por request | 4 | `src/intake/images.ts` |
| Peso por imagen (decodificada) | 4 MiB | `src/intake/images.ts` |
| Total de imágenes (decodificado) | 8 MiB | `src/intake/images.ts` |
| Body HTTP estimado | 13 MiB | `src/intake/images.ts` |
| Megapíxeles por imagen | 16 MP | `src/intake/images.ts` |
| Timeout por llamada | 60 s (default) | `src/providers/cloudflare.ts` |

### Clef-flash (ficha del proveedor)

| Dato | Valor |
| --- | --- |
| Ventana de contexto | 24.576 tokens |
| Costo de entrada | USD 0,038 por millón de tokens |
| Costo de salida | sin costo |
| Costo de imágenes | cada imagen consume hasta 1024 tokens de la ventana |

Estos valores no están codificados en el repo: son datos de la ficha de Cloudflare y pueden cambiar. El motor solo reporta `usage.input_tokens`/`usage.output_tokens` cuando el endpoint los devuelve.

## Mapeo a `src/providers/types.ts`

```ts
interface DecisionProvider {
  readonly name: string;
  readonly kind: ProviderKind;
  evaluate(request: DecisionRequest, options?: DecideOptions): Promise<DecisionResponse>;
}
```

| Tipo | Campos | Uso |
| --- | --- | --- |
| `DecisionRequest` | `model`, `state`, `questions`, `images?` | Lo arma el motor, una vez por etapa. |
| `Question` | unión `NoulQuestion \| ChoiceQuestion \| ScoreQuestion` | Se construye desde cada criterio. |
| `ImageInput` | `content_type`, `base64` | Imágenes ya cargadas y validadas. |
| `DecisionResponse` | `model`, `answers`, `usage?`, `raw?` | Lo que devuelve el provider al motor. |
| `DecideOptions` | `signal?` | `AbortSignal` compuesto con el timeout. |
| `ProviderConfig` | `kind`, `model?`, `baseUrl?`, `accountId?`, `apiKeyEnv?`, `apiKey?`, `headers?`, `unwrap?`, `timeoutMs?`, `fixturesDir?` | Config por alias. |

Flujo: `registry.createProvider(alias, cfg)` elige la factory; `evaluate()` hace el POST y devuelve `DecisionResponse`; el motor normaliza y agrega. El provider **no** normaliza, no decide y no conoce la receta.

### Requisitos para ser "systemone compatible"

1. Aceptar `POST <baseUrl>` con `Content-Type: application/json`.
2. Aceptar `Authorization: Bearer <key>` (o ignorarlo si no hay key).
3. Leer `{ model, state, questions, images? }` con `questions` como mapa `id → { type, instructions, criteria? }`.
4. Responder JSON con `answers: { <id>: <respuesta> }`, ya sea en la raíz o dentro de `result`.
5. Devolver para cada pregunta el mismo `type` enviado, con `noul` (0..1), `choice` (+ `probabilities`) o `score` (+ `probabilities`).
6. Opcional: `usage.input_tokens`, `usage.output_tokens`, `model`, `legend`.
7. Soportar (o rechazar explícitamente) `images` como `{ content_type, base64 }`.

## Discrepancias detectadas

1. `src/providers/cloudflare.ts:31-34` resuelve la key solo desde `cfg.apiKey` o la variable de entorno; **no** lee `credentials.json`. Ese merge lo hace la CLI en `src/cli/commands/run.ts:82-87`. Un consumidor de la librería que llame `createProvider` directamente debe pasar `apiKey`/`accountId` en la config.
2. `.env.example` declara `LOCAL_API_KEY`, pero `src/providers/systemone.ts:44` usa `SYSTEMONE_API_KEY` por defecto si el provider no define `apiKeyEnv`.
3. `src/providers/typesafe.ts:35-40` rechaza imágenes aunque el contrato común las contemple; la diferencia es del proveedor, no del motor.
4. Los costos y el contexto de Clef-flash no están en el código; se documentan desde la ficha del proveedor y no se validan en runtime.
