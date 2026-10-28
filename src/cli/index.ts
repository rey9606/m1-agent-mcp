#!/usr/bin/env node
import { Command } from 'commander';
import { runCommand } from './commands/run';
import { recipeSchemaCommand, recipeValidateCommand } from './commands/recipe';
import { authRemoveCommand, authSetCommand, authStatusCommand } from './commands/auth';
import { doctorCommand } from './commands/doctor';

const program = new Command();

program
  .name('m1')
  .description('Agentes de decisión (Clef/JEV) definidos por recetas JSON')
  .version('0.1.0', '-v, --version', 'muestra la versión');

program
  .command('run')
  .description('ejecuta una receta sobre un trabajo')
  .argument('<recipe>', 'ruta al JSON de la receta')
  .option('-i, --input <file>', 'JSON con los slots de entrada')
  .option('--state <text>', 'texto para el slot principal')
  .option('--state-file <file>', 'archivo de texto para el slot principal')
  .option('--image <path>', 'imagen (repetible)', (v: string, acc: string[] = []) => [...acc, v], [] as string[])
  .option('--slot <name>', 'slot destino para --state/--state-file')
  .option('--image-slot <name>', 'slot destino para --image')
  .option('--stdin', 'lee el trabajo desde stdin (JSON o texto)')
  .option('--provider <alias>', 'provider a usar (override de la config)')
  .option('--model <id>', 'modelo a usar (override)')
  .option('--timeout <ms>', 'timeout total por etapa')
  .option('--dry-run', 'arma el request y no llama al proveedor')
  .option('--trace', 'muestra las etapas por stderr')
  .option('--json', 'salida JSON (contrato estable)')
  .option('--compact', 'salida de una línea')
  .option('-c, --config <file>', 'ruta a m1.config.json')
  .action(async (recipe: string, flags) => {
    await runCommand(recipe, flags);
  });

const recipe = program.command('recipe').description('herramientas de recetas');

recipe
  .command('validate')
  .description('valida una receta sin ejecutarla')
  .argument('<file>', 'ruta al JSON de la receta')
  .option('--json', 'salida JSON')
  .action(async (file: string, flags) => {
    await recipeValidateCommand(file, flags);
  });

recipe
  .command('schema')
  .description('imprime el JSON Schema de una receta')
  .option('--json', 'salida JSON (igual)')
  .action((flags) => {
    recipeSchemaCommand(flags);
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
  .action((flags) => {
    doctorCommand(flags);
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`\n  ✗ ${(e as Error).message}\n\n`);
  process.exit(2);
});
