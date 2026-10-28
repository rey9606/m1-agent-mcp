---
name: m1-agent
description: Evalúa textos, pantallas y otros artefactos con workflows JSON deterministas usando la CLI m1 (npx m1-agent). Usar cuando haya que juzgar algo contra criterios y umbrales y obtener pass/fail/needs_review con remediaciones, o cuando el usuario mencione m1, copy-checker, ux-checker o "workflow de evaluación".
license: MIT
---

# m1 — evaluar, no redactar

`m1` ejecuta un **workflow JSON**: le hace al modelo preguntas de tipo cerrado (`noul` = sí/no, `choice` = una opción, `score` = un nivel) y **calcula** el veredicto, el score y las remediaciones. El modelo sólo responde; la decisión es determinista.

**No es un generador de texto.** Si te piden redactar, resumir o traducir, no uses m1.

## El flujo, siempre igual

1. `m1 doctor --json` — una vez por entorno. Si `ok: true`, seguí.
2. `m1 workflow list --json` — qué workflows existen. **No inventes nombres.**
3. `m1 workflow explain <nombre>` — sólo si necesitás saber qué slots pide y qué evalúa cada etapa.
4. `m1 run <nombre> ... --agent` — la corrida real.
5. Leé el **exit code** y el payload de `--agent`. Aplicá `issues[].remediation` y volvé a correr.

## Provider (una sola vez)

```bash
m1 provider presets      # cloudflare | openrouter | typesafe | llamacpp | custom
m1 provider add cf --preset cloudflare \
  --api-key "$CLOUDFLARE_API_TOKEN" --account-id "$CLOUDFLARE_ACCOUNT_ID" --default
m1 provider test cf --json
```

Sin provider, `m1` cae en `mock` (resultados simulados) y lo avisa por stderr. Si ves ese aviso, **pará**: el veredicto no es real.

## Correr

```bash
# texto
m1 run copy-checker --slot copy --state "Empezá tu prueba gratis. Sin tarjeta." --agent

# texto largo desde archivo
m1 run copy-checker --slot copy --state-file ./landing.txt --agent

# pantalla (imagen)
m1 run ux-checker --slot brief "App de turnos, audiencia 30-50" \
  --image ./home.png --agent --timeout 300000

# varios slots a la vez
m1 run ux-checker --input ./entrada.json --agent
```

- Workflows **sólo por nombre**. Una ruta `.json` es escape hatch de CI: no la uses en el flujo normal.
- `--slot <name>` decide a qué slot va `--state`. Si no sabés cuál es, `m1 workflow explain <nombre>`.
- `--image` es repetible; `--image-slot` si el workflow tiene más de un slot de imagen.
- Con imágenes y modelo local, subí `--timeout 300000`.

## Elegir la salida

| flag | qué devuelve | cuándo |
| --- | --- | --- |
| `--agent` | JSON mínimo (~200 tokens) | **siempre**, para decidir el próximo paso |
| `--json` | JSON completo (criterios, probabilidades, trace) | depurar o auditar |
| `--compact` | una línea `[FAIL] copy-checker score=60 ...` | logs |
| sin flag | texto para humanos | mostrarle al usuario |

## Qué devuelve `--agent`

```json
{
  "ok": true,
  "runId": "run_0fe9f606a4d0",
  "workflow": "copy-checker",
  "verdict": "fail",
  "score": 60,
  "issues": [
    {
      "criterion": "CP-4",
      "severity": "major",
      "message": "Corrección: 0.52 < 0.8",
      "remediation": "Pasá corrector y leé en voz alta; unificá comillas, guiones y mayúsculas."
    }
  ],
  "gates": [
    { "id": "A3", "expr": "quality >= 0.7", "severity": "major", "detail": "quality = 0.6" }
  ],
  "derived": { "quality": 0.6 },
  "passed": ["CP-3", "CP-5"],
  "meta": { "provider": "liquid", "model": "d1-omni-600M", "calls": 2, "ms": 15970 }
}
```

- `issues[]` — criterios que no llegaron a su umbral. Siempre traen `remediation`.
- `gates[]` — umbrales globales (`acceptance`) que fallaron. `detail` muestra el valor actual.
- `passed[]` — criterios aprobados con peso. No los repitas en tu respuesta.
- `derived` — índices calculados (ej. `quality`).

## Exit codes: la fuente de verdad

| code | veredicto | qué hacer |
| --- | --- | --- |
| `0` | pass | listo, reportá |
| `1` | fail | **no es un error de la herramienta**: aplicá las remediaciones y volvé a correr |
| `2` | error | leé `error.code` y `error.hint` (stderr); corregí el comando, no el artefacto |
| `3` | needs_review | falta evidencia o confianza baja: pedí contexto, no "arregles" a ciegas |

Ramificá por exit code, **nunca** por el texto de la salida.

## Errores frecuentes

| síntoma | causa | fix |
| --- | --- | --- |
| `E_USAGE` + "unknown option" | flag inventado | `m1 run --help` |
| `E_INPUT` "falta el slot X" | slot mal elegido o falta `--image` | `m1 workflow explain <nombre>` |
| `E_VALIDATION` | workflow inválido | `m1 workflow validate <nombre>` |
| `E_CONFIG` | provider inexistente o mal configurado | `m1 doctor --json`, `m1 provider list` |
| `E_PROVIDER` 401/403 | credencial inválida | `m1 auth set <alias> --token ...` |
| `E_PROVIDER` 404 | `baseUrl` o `accountId` mal | `m1 provider show <alias>` |
| `E_TIMEOUT` | etapa lenta (imágenes, modelo local) | `--timeout 300000` |
| aviso "mock de emergencia" | no hay provider | configuralo antes de confiar en el veredicto |

## Escribir un workflow

```bash
m1 workflow new mi-check --from copy-checker --description "Check de emails"
m1 workflow edit mi-check        # valida al guardar
m1 workflow validate mi-check
m1 workflow explain mi-check     # ¿se entiende lo que hace?
m1 workflow explain mi-check --format mermaid   # diagrama del flujo
```

Piezas: `input.slots` (qué recibe), `criteria` (pregunta + `passAt` + `weight` + `severity`), `stages` (lotes de preguntas, con `when` condicional), `derived` (índices) y `acceptance` (gates del veredicto). Referencia: `m1 workflow guide` y `m1 workflow schema`.

## Lo que no se hace

- No parsees la salida humana ni `--compact`: usá `--agent`.
- No inventes workflows, slots ni flags: `workflow list` y `--help` son la verdad.
- No uses m1 para generar contenido.
- No reintentes un `E_PROVIDER` igual: leé el `hint`.
- No reportes `fail` como error del sistema.

## Más contexto

- `m1 guide --json` — tutorial completo y estable.
- `AGENTS.md` — contrato operativo de la CLI.
- `docs/for-agents.md` — construir entradas, autoría de workflows, errores.