import { CLI_VERSION } from '../version';
import { fail } from '../output';

export interface GuideFlags {
  json?: boolean;
}

export interface GuideSection {
  id: string;
  title: string;
  body: string;
  commands?: string[];
}

/**
 * Tutorial en texto plano pensado para agentes: qué hace la CLI, cómo
 * descubrir comandos, qué devuelve, cómo interpretar exit codes y errores.
 * `m1 guide --json` expone las mismas secciones de forma estructurada.
 */
export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'que-es',
    title: 'Qué es m1',
    body:
      'Ejecuta workflows JSON contra modelos de decisión. Cada etapa hace preguntas tipadas ' +
      '(noul = sí/no, choice = una opción, score = nivel ordenado) sobre un state y devuelve ' +
      'respuestas normalizadas, un verdict y un score. No genera texto libre: no le pidas redactar.',
    commands: ['m1 workflow list', 'm1 run copy-checker --state "texto a evaluar"'],
  },
  {
    id: 'flujo',
    title: 'Flujo recomendado (3 pasos)',
    body:
      '1) m1 doctor verifica entorno y providers. ' +
      '2) m1 run <workflow> --state "..." ejecuta y devuelve verdict/score/issues. ' +
      '3) Si el verdict es fail (exit 1), leé issues[].remediation: el workflow ya trae la corrección sugerida.',
    commands: [
      'm1 doctor',
      'm1 run copy-checker --state "Nuestra herramienta usa IA"',
      'm1 run ux-checker --image pantalla.png --state "App de tareas"',
    ],
  },
  {
    id: 'comandos',
    title: 'Comandos',
    body:
      'run ejecuta un workflow (por nombre) · workflow list|show|new|import|export|edit|delete|validate|schema|guide ' +
      'administra workflows · provider list|presets|add|edit|remove|set-default|test configura providers · ' +
      'models lista el catálogo del provider · model show|use|reset gestiona el modelo · ' +
      'local start|status|stop administra el servidor local · auth set|status|remove gestiona credenciales · ' +
      'doctor diagnostica · guide muestra esta ayuda.',
    commands: [
      'm1 run --help',
      'm1 workflow list',
      'm1 provider presets',
      'm1 local start --provider liquid',
      'm1 models --provider or --free',
    ],
  },
  {
    id: 'salida',
    title: 'Salida y contrato JSON',
    body:
      'Todos los comandos aceptan --json y escriben un único objeto JSON en stdout ' +
      '(los errores van a stderr con {ok:false,error:{code,message,hint,details}}). ' +
      'run devuelve {ok, verdict, score, criteria[], issues[], derivados, usage, trace}.',
    commands: ['m1 run copy-checker --state "texto" --json', 'm1 doctor --json'],
  },
  {
    id: 'exit-codes',
    title: 'Exit codes',
    body:
      '0 pass · 1 fail (el workflow se ejecutó y no cumple la aceptación) · ' +
      '2 error (uso, config, input o provider) · 3 needs_review (faltan datos o confianza baja). ' +
      'Un agente debe ramificar por exit code, no por el texto.',
  },
  {
    id: 'errores',
    title: 'Cómo recuperarse de errores',
    body:
      'E_USAGE: comando/flag inválido → mirá m1 <comando> --help. ' +
      'E_VALIDATION: el workflow no cumple el schema → m1 workflow validate <nombre> y revisá details.path. ' +
      'E_INPUT: falta un slot o una imagen → revisá --state/--input/--image. ' +
      'E_CONFIG: provider o config mal definidos → m1 doctor. ' +
      'E_PROVIDER: el endpoint rechazó la llamada → leé hint y details. ' +
      'E_TIMEOUT: subí --timeout (multimodal local: 300000). ' +
      'E_INTERNAL: bug; reportá comando e input.',
  },
  {
    id: 'config',
    title: 'Configuración',
    body:
      'Busca m1.config.json en el cwd y luego ~/.config/m1-agent/config.json. ' +
      'Si no encuentra ninguno usa una config de emergencia (provider mock). ' +
      '-c/--config fuerza una ruta; --provider elige el alias.',
    commands: ['m1 doctor --json', 'm1 provider list', 'm1 run copy-checker -c ./m1.config.json'],
  },
  {
    id: 'local',
    title: 'Modelo local',
    body:
      'Con providers kind systemone + launch, m1 sondea /health y levanta el servidor si no responde ' +
      '(autoStart default always). Si el modelo GGUF falta, pregunta antes de descargarlo; en CI usá ' +
      '--download. El servidor queda corriendo entre runs; se apaga con m1 local stop o cerrando su consola.',
    commands: [
      'm1 local start --provider liquid',
      'm1 local start --provider liquid --download',
      'm1 local status --provider liquid',
      'm1 local stop --provider liquid',
    ],
  },
  {
    id: 'workflows',
    title: 'Workflows',
    body:
      'Un workflow declara slots de entrada, criteria (preguntas) y stages. Se invoca sólo por nombre ' +
      '(sin ruta ni .json). Hay built-in de sólo lectura y workflows de usuario en ' +
      '~/.config/m1-agent/workflows/. Usá m1 workflow guide para el formato y m1 workflow schema para el JSON Schema.',
    commands: [
      'm1 workflow list',
      'm1 workflow new mi-copy --from copy-checker',
      'm1 workflow guide',
      'm1 workflow validate mi-copy',
      'm1 workflow schema',
    ],
  },
  {
    id: 'agentes',
    title: 'Reglas para agentes',
    body:
      '1) Preferí siempre --json y parseá stdout. 2) No inventes flags: usá m1 <comando> --help. ' +
      '3) Usá --dry-run o --print-request para inspeccionar el request sin gastar llamadas. ' +
      '4) Ramificá por exit code. 5) En errores, seguí hint antes de reintentar; no repitas el mismo comando igual. ' +
      '6) Para imágenes locales: --image y --timeout 300000.',
    commands: ['m1 run copy-checker --print-request', 'm1 run copy-checker --state "x" --json'],
  },
];

export function guideCommand(flags: GuideFlags): never {
  try {
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, version: CLI_VERSION, sections: GUIDE_SECTIONS }) + '\n',
      );
    } else {
      process.stdout.write(`m1 v${CLI_VERSION} — guía rápida\n\n`);
      for (const section of GUIDE_SECTIONS) {
        process.stdout.write(`## ${section.title}\n${section.body}\n`);
        if (section.commands && section.commands.length > 0) {
          for (const command of section.commands) process.stdout.write(`  $ ${command}\n`);
        }
        process.stdout.write('\n');
      }
      process.stdout.write('Ayuda puntual: m1 <comando> --help · Versión JSON: m1 guide --json\n');
    }
    process.exit(0);
  } catch (e) {
    fail(e, Boolean(flags.json));
  }
}