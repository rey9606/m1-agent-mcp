#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { runCommand } from './commands/run';
import {
  workflowDeleteCommand,
  workflowEditCommand,
  workflowExportCommand,
  workflowGuideCommand,
  workflowImportCommand,
  workflowListCommand,
  workflowNewCommand,
  workflowSchemaCommand,
  workflowShowCommand,
  workflowValidateCommand,
} from './commands/workflow';
import {
  providerAddCommand,
  providerEditCommand,
  providerListCommand,
  providerPresetsCommand,
  providerRemoveCommand,
  providerSetDefaultCommand,
  providerShowCommand,
  providerTestCommand,
} from './commands/provider';
import { authRemoveCommand, authSetCommand, authStatusCommand } from './commands/auth';
import { doctorCommand } from './commands/doctor';
import { modelResetCommand, modelShowCommand, modelUseCommand, modelsCommand } from './commands/models';
import { localStartCommand, localStatusCommand, localStopCommand } from './commands/local';
import { guideCommand } from './commands/guide';
import { fail } from './output';
import { CLI_VERSION } from './version';
import { M1Error } from '../core/errors';

/** Salida de commander: se captura para reformatearla como E_USAGE (o JSON). */
let commanderStderr = '';

const ROOT_HELP = `
Ejemplos:
  $ m1 guide                                   tutorial completo para agentes
  $ m1 doctor                                  verifica entorno, config y providers
  $ m1 workflow list                           workflows disponibles (nombre + descripción)
  $ m1 run copy-checker --state "texto a evaluar"
  $ m1 run ux-checker --image pantalla.png --timeout 300000 --json
  $ m1 provider list                           providers configurados
  $ m1 local start --provider liquid           levanta el modelo local si no responde

Contrato para agentes:
  · Todos los comandos aceptan --json (un único objeto JSON en stdout).
  · Los errores van a stderr como { ok:false, error:{ code, message, hint, details }, docs }.
  · Exit codes: 0 pass · 1 fail · 2 error · 3 needs_review.
  · Ayuda puntual: m1 <comando> --help · Guía en JSON: m1 guide --json`;

const COMMAND_FOOTER = `
Más ayuda:
  m1 guide                     tutorial completo para agentes (o --json)
  m1 <comando> --help          opciones y argumentos del comando
  Exit codes: 0 pass · 1 fail · 2 error · 3 needs_review`;

const program = new Command();

// Captura la salida de error de commander; la formateamos nosotros (E_USAGE/JSON).
program.configureOutput({
  writeErr: (str) => {
    commanderStderr += str;
  },
});

// Debe configurarse antes de crear subcomandos: commander copia el callback al crearlos.
program.exitOverride();

program
  .name('m1')
  .description('Agentes de decisión (Clef/JEV) definidos por workflows JSON')
  .version(CLI_VERSION, '-v, --version', 'muestra la versión')
  .showSuggestionAfterError(true)
  .addHelpText('after', ROOT_HELP);

program
  .command('guide')
  .description('tutorial para agentes: comandos, salida JSON, exit codes y recuperación de errores')
  .option('--json', 'guía estructurada en JSON')
  .action((flags) => {
    guideCommand(flags);
  });

program
  .command('run')
  .description('ejecuta un workflow sobre un trabajo')
  .argument('<workflow>', 'nombre del workflow (o ruta .json para CI)')
  .option('-i, --input <file>', 'JSON con los slots de entrada')
  .option('--state <text>', 'texto para el slot principal')
  .option('--state-file <file>', 'archivo de texto para el slot principal')
  .option('--image <path>', 'imagen (repetible)', (v: string, acc: string[] = []) => [...acc, v], [] as string[])
  .option('--slot <name>', 'slot destino para --state/--state-file')
  .option('--image-slot <name>', 'slot destino para --image')
  .option('--stdin', 'lee el trabajo desde stdin (JSON o texto)')
  .option('--provider <alias>', 'provider a usar (override de la config)')
  .option('--model <id>', 'modelo a usar (override)')
  .option('--timeout <ms>', 'timeout por etapa (no del run completo)')
  .option('--local-start <mode>', 'ask|always|never: levanta el modelo local si no responde (default: always)')
  .option('--download', 'permite descargar el modelo GGUF si falta (sin preguntar)')
  .option('--dry-run', 'arma el request y no llama al proveedor')
  .option('--print-request', 'imprime el/los request(s) que se enviarían (implica --dry-run)')
  .option('--trace', 'muestra las etapas por stderr')
  .option('--json', 'salida JSON (contrato estable)')
  .option('--compact', 'salida de una línea')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action(async (workflow: string, flags) => {
    await runCommand(workflow, flags);
  });

program
  .command('models')
  .description('lista los modelos disponibles del provider')
  .option('--provider <alias>', 'provider a consultar (default: el de la config)')
  .option('--search <texto>', 'filtra por id/nombre/descripción')
  .option('--free', 'sólo modelos publicados como gratis')
  .option('--json', 'salida JSON (contrato estable)')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action(async (flags) => {
    await modelsCommand(flags);
  });

const model = program.command('model').description('modelo efectivo del provider');

model
  .command('show')
  .description('muestra el modelo efectivo, su fuente y capacidades')
  .option('--provider <alias>', 'provider a consultar (default: el de la config)')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action((flags) => {
    modelShowCommand(flags);
  });

model
  .command('use')
  .description('fija el modelo del provider (preferencia de usuario o --project)')
  .argument('<id>', 'id del modelo (ej: @cf/cloudflare/clef-omni)')
  .option('--provider <alias>', 'provider a modificar (default: el de la config)')
  .option('--project', 'escribe providers.<alias>.model en m1.config.json')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action((id: string, flags) => {
    modelUseCommand(id, flags);
  });

model
  .command('reset')
  .description('borra la preferencia de modelo del usuario')
  .option('--provider <alias>', 'provider a resetear (default: el de la config)')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action((flags) => {
    modelResetCommand(flags);
  });

const local = program.command('local').description('servidor del modelo local');

local
  .command('status')
  .description('muestra si el servidor local está corriendo (sin arrancarlo)')
  .option('--provider <alias>', 'provider local a consultar (default: el de la config)')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action(async (flags) => {
    await localStatusCommand(flags);
  });

local
  .command('start')
  .description('levanta el servidor local si no responde y lo deja corriendo')
  .option('--provider <alias>', 'provider local a levantar (default: el de la config)')
  .option('--download', 'descarga el modelo GGUF si falta, sin preguntar')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action(async (flags) => {
    await localStartCommand(flags);
  });

local
  .command('stop')
  .description('detiene el servidor local registrado')
  .option('--provider <alias>', 'provider local a detener (default: el de la config)')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action((flags) => {
    localStopCommand(flags);
  });

const workflow = program
  .command('workflow')
  .description('workflows: listar, crear, importar/exportar y validar');

workflow
  .command('list')
  .alias('ls')
  .description('lista los workflows con nombre, tipo y descripción')
  .option('--json', 'salida JSON')
  .action((flags) => {
    workflowListCommand(flags);
  });

workflow
  .command('show')
  .description('muestra un workflow completo por nombre')
  .argument('<name>', 'nombre del workflow')
  .option('--json', 'salida JSON')
  .action((name: string, flags) => {
    workflowShowCommand(name, flags);
  });

workflow
  .command('new')
  .alias('create')
  .description('crea un workflow nuevo en ~/.config/m1-agent/workflows')
  .argument('<name>', 'nombre (minúsculas, números y guiones)')
  .option('--from <name>', 'copia un workflow existente como base')
  .option('--role <role>', 'rol del evaluador')
  .option('--description <text>', 'descripción de una línea')
  .option('--json', 'salida JSON')
  .action((name: string, flags) => {
    workflowNewCommand(name, flags);
  });

workflow
  .command('import')
  .description('importa un workflow desde un archivo JSON')
  .argument('<file>', 'ruta al archivo JSON')
  .option('--name <name>', 'nombre destino (default: el id del archivo)')
  .option('--json', 'salida JSON')
  .action((file: string, flags) => {
    workflowImportCommand(file, flags);
  });

workflow
  .command('export')
  .description('exporta un workflow (stdout o --out)')
  .argument('<name>', 'nombre del workflow')
  .option('--out <file>', 'escribe el JSON en un archivo')
  .action((name: string, flags) => {
    workflowExportCommand(name, flags);
  });

workflow
  .command('edit')
  .description('abre el workflow en $EDITOR y lo valida al guardar')
  .argument('<name>', 'nombre del workflow (no built-in)')
  .option('--json', 'salida JSON')
  .action((name: string, flags) => {
    workflowEditCommand(name, flags);
  });

workflow
  .command('delete')
  .alias('rm')
  .description('borra un workflow de usuario (los built-in son de sólo lectura)')
  .argument('<name>', 'nombre del workflow')
  .option('--yes', 'no pedir confirmación')
  .option('--json', 'salida JSON')
  .action(async (name: string, flags) => {
    await workflowDeleteCommand(name, flags);
  });

workflow
  .command('validate')
  .description('valida un workflow sin ejecutarlo')
  .argument('<ref>', 'nombre del workflow (o ruta .json)')
  .option('--json', 'salida JSON')
  .action((ref: string, flags) => {
    workflowValidateCommand(ref, flags);
  });

workflow
  .command('schema')
  .description('imprime el JSON Schema de un workflow')
  .option('--json', 'salida JSON (igual)')
  .action(() => {
    workflowSchemaCommand();
  });

workflow
  .command('guide')
  .description('cómo escribir un workflow en el formato correcto (para agentes)')
  .option('--json', 'guía estructurada en JSON')
  .action((flags) => {
    workflowGuideCommand(flags);
  });

const provider = program.command('provider').description('providers: presets, alta, edición y default');

provider
  .command('list')
  .alias('ls')
  .description('lista los providers de la config global')
  .option('--json', 'salida JSON')
  .action((flags) => {
    providerListCommand(flags);
  });

provider
  .command('presets')
  .description('presets disponibles (cloudflare, openrouter, typesafe, llamacpp, custom)')
  .option('--json', 'salida JSON')
  .action((flags) => {
    providerPresetsCommand(flags);
  });

provider
  .command('show')
  .description('muestra un provider sin revelar secretos')
  .argument('<alias>', 'alias del provider')
  .option('--json', 'salida JSON')
  .action((alias: string, flags) => {
    providerShowCommand(alias, flags);
  });

provider
  .command('add')
  .description('agrega un provider a la config global')
  .argument('<alias>', 'alias del provider')
  .option('--preset <id>', 'cloudflare|openrouter|typesafe|llamacpp|custom')
  .option('--kind <kind>', 'cloudflare|typesafe|openrouter|systemone|mock')
  .option('--base-url <url>', 'URL del endpoint (systemone/custom)')
  .option('--model <id>', 'modelo por defecto')
  .option('--api-key <key>', 'API key (se guarda en credentials.json)')
  .option('--api-key-env <VAR>', 'variable de entorno con la API key')
  .option('--account-id <id>', 'account id (Cloudflare)')
  .option('--default', 'dejarlo como provider default')
  .option('--json', 'salida JSON')
  .action((alias: string, flags) => {
    providerAddCommand(alias, flags);
  });

provider
  .command('edit')
  .description('edita un provider existente (sólo los campos indicados)')
  .argument('<alias>', 'alias del provider')
  .option('--base-url <url>', 'URL del endpoint')
  .option('--model <id>', 'modelo por defecto')
  .option('--api-key <key>', 'API key (se guarda en credentials.json)')
  .option('--api-key-env <VAR>', 'variable de entorno con la API key')
  .option('--account-id <id>', 'account id (Cloudflare)')
  .option('--clear-api-key', 'borra la API key guardada')
  .option('--json', 'salida JSON')
  .action((alias: string, flags) => {
    providerEditCommand(alias, flags);
  });

provider
  .command('remove')
  .alias('rm')
  .description('elimina un provider y su credencial')
  .argument('<alias>', 'alias del provider')
  .option('--yes', 'no pedir confirmación')
  .option('--force', 'permite borrar el provider default')
  .option('--json', 'salida JSON')
  .action(async (alias: string, flags) => {
    await providerRemoveCommand(alias, flags);
  });

provider
  .command('set-default')
  .alias('use')
  .description('fija el provider default')
  .argument('<alias>', 'alias del provider')
  .option('--json', 'salida JSON')
  .action((alias: string, flags) => {
    providerSetDefaultCommand(alias, flags);
  });

provider
  .command('test')
  .description('chequeos estructurales del provider (sin red)')
  .argument('<alias>', 'alias del provider')
  .option('--json', 'salida JSON')
  .action(async (alias: string, flags) => {
    await providerTestCommand(alias, flags);
  });

const auth = program.command('auth').description('credenciales de proveedores');

auth
  .command('set')
  .description('guarda credenciales para un provider')
  .argument('<alias>', 'alias del provider (ej: cf)')
  .option('--token <key>', 'API key')
  .option('--account-id <id>', 'account id (Cloudflare)')
  .option('--env <VAR>', 'sólo indica la variable de entorno a usar')
  .option('--json', 'salida JSON')
  .action((alias: string, flags) => {
    authSetCommand(alias, flags);
  });

auth
  .command('status')
  .description('muestra qué providers están configurados (sin imprimir secretos)')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action((flags) => {
    authStatusCommand(flags);
  });

auth
  .command('remove')
  .alias('rm')
  .description('elimina las credenciales guardadas de un provider')
  .argument('<alias>', 'alias del provider')
  .option('--json', 'salida JSON')
  .action((alias: string, flags) => {
    authRemoveCommand(alias, flags);
  });

program
  .command('doctor')
  .description('diagnóstico del entorno y providers')
  .option('--json', 'salida JSON')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action(async (flags) => {
    await doctorCommand(flags);
  });

/** Agrega el pie de ayuda (guía + exit codes) a todos los subcomandos. */
function addHelpFooter(command: Command): void {
  command.addHelpText('after', COMMAND_FOOTER);
  for (const sub of command.commands) addHelpFooter(sub);
}

for (const command of program.commands) addHelpFooter(command);

// `m1` sin argumentos: ayuda completa y exit 0 (no es un error de uso).
if (process.argv.length <= 2) {
  program.outputHelp();
  process.exit(0);
}

function jsonRequested(): boolean {
  return process.argv.includes('--json');
}

program.parseAsync(process.argv).catch((e: unknown) => {
  if (e instanceof CommanderError) {
    // `--help` y `--version` ya escribieron su salida: no son errores.
    if (e.exitCode === 0) process.exit(0);
    const lines = commanderStderr
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((line) => line.replace(/^error:\s*/u, ''));
    const message = lines.join(' ').trim() || e.message;
    fail(
      new M1Error('E_USAGE', message, {
        hint: 'comando o flag inválido: revisá `m1 guide` o `m1 <comando> --help`',
      }),
      jsonRequested(),
    );
  }
  fail(e, jsonRequested());
});