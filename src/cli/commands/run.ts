import { basename } from 'node:path';
import { M1Error } from '../../core/errors';
import { runRecipe } from '../../core/engine';
import { validateRecipe } from '../../core/validate';
import { readWorkflowFile, resolveWorkflowPath } from '../../workflows/store';
import { loadConfig, resolveProvider } from '../../config/config';
import { resolveSecrets, loadCredentials } from '../../config/credentials';
import { loadPreferences } from '../../config/preferences';
import { ensureLocalEndpoint } from '../../local/lifecycle';
import { createProvider, resolveEffectiveModel } from '../../providers/registry';
import type { LocalAutoStart } from '../../providers/types';
import { buildRunInput } from '../io';
import { EXIT, fail } from '../output';
import { renderHuman } from '../../render/human';
import { renderJson } from '../../render/json';
import { renderCompact } from '../../render/compact';
import { renderAgent } from '../../render/agent';
import type { DecisionProvider } from '../../providers/types';

export interface RunFlags {
  input?: string;
  state?: string;
  stateFile?: string;
  image?: string[];
  slot?: string;
  imageSlot?: string;
  stdin?: boolean;
  json?: boolean;
  compact?: boolean;
  agent?: boolean;
  trace?: boolean;
  dryRun?: boolean;
  printRequest?: boolean;
  provider?: string;
  model?: string;
  config?: string;
  timeout?: string;
  /** Política para levantar el modelo local: ask | always | never. */
  localStart?: string;
  /** Permite descargar el modelo GGUF si falta, sin preguntar. */
  download?: boolean;
}

function parseLocalPolicy(value: string | undefined): LocalAutoStart | undefined {
  if (value === undefined) return undefined;
  if (value === 'ask' || value === 'always' || value === 'never') return value;
  throw new M1Error('E_USAGE', `--local-start inválido: "${value}"`, {
    hint: 'valores permitidos: ask, always, never',
  });
}

/**
 * Acepta un nombre de workflow (`copy-checker`) o, como escape hatch para CI,
 * una ruta a un `.json`. La resolución y la lectura viven en `workflows/store`.
 */
function loadWorkflow(ref: string) {
  const path = resolveWorkflowPath(ref);
  const raw = readWorkflowFile(path);
  return validateRecipe(raw, { filePath: path, defaultId: basename(path).replace(/\.json$/i, '') });
}

const dryProvider: DecisionProvider = {
  name: 'dry-run',
  kind: 'mock',
  evaluate: async () => {
    throw new M1Error('E_PROVIDER', 'dry-run no ejecuta llamadas');
  },
};

export async function runCommand(workflowRef: string, flags: RunFlags): Promise<never> {
  const json = Boolean(flags.json);
  const dryRun = Boolean(flags.dryRun || flags.printRequest);
  const requests: unknown[] = [];
  try {
    const { recipe, warnings } = loadWorkflow(workflowRef);
    if (!json && warnings.length > 0) {
      for (const w of warnings) process.stderr.write(`  ! ${w}\n`);
    }

    const config = loadConfig({ explicit: flags.config });
    if (!json && config.source === '(builtin)') {
      process.stderr.write(
        '  ! no hay ningún provider configurado: uso el mock de emergencia (resultados simulados)\n' +
          '    configurá uno con `m1 provider presets` y `m1 provider add <alias> --preset <id>`\n',
      );
    }
    const preferenceWarnings: string[] = [];
    const preferences = loadPreferences(preferenceWarnings);
    if (!json) {
      for (const warning of preferenceWarnings) process.stderr.write(`  ! ${warning}\n`);
    }

    const { alias, config: resolvedCfg } = resolveProvider(config, flags.provider ?? recipe.provider, {
      model: flags.model,
      timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    });
    let providerCfg = resolvedCfg;
    const effective = resolveEffectiveModel({
      cfg: providerCfg,
      flagModel: flags.model,
      preferredModel: preferences.models?.[alias],
    });

    let provider: DecisionProvider;
    let model: string;
    if (dryRun) {
      provider = dryProvider;
      model = effective.model;
    } else {
      const localPolicy = parseLocalPolicy(flags.localStart);
      const local = await ensureLocalEndpoint({
        alias,
        cfg: providerCfg,
        ...(localPolicy !== undefined ? { autoStart: localPolicy } : {}),
        ...(flags.download !== undefined ? { download: flags.download } : {}),
        interactive: !json && Boolean(process.stdin.isTTY && process.stderr.isTTY),
        onStatus: (line) => {
          if (!json) process.stderr.write(`  … ${line}\n`);
        },
      });
      if (!json) {
        for (const warning of local.warnings) process.stderr.write(`  ! ${warning}\n`);
      }
      if (local.baseUrl && local.baseUrl !== providerCfg.baseUrl) {
        providerCfg = { ...providerCfg, baseUrl: local.baseUrl };
      }
      if (!json && local.started) {
        const pid = local.pid !== undefined ? ` (pid ${local.pid})` : '';
        process.stderr.write(
          `  ✓ servidor local listo en ${local.baseUrl}${pid} — queda corriendo; apagalo con \`m1 local stop --provider ${alias}\`\n`,
        );
      }

      const secrets = resolveSecrets(alias, providerCfg);
      const merged = {
        ...providerCfg,
        model: effective.model,
        apiKey: providerCfg.apiKey ?? secrets.apiKey,
        accountId: providerCfg.accountId ?? secrets.accountId,
      };
      provider = createProvider(alias, merged);
      model = effective.model;
    }

    const input = await buildRunInput(
      {
        input: flags.input,
        state: flags.state,
        stateFile: flags.stateFile,
        images: flags.image ?? [],
        slot: flags.slot,
        imageSlot: flags.imageSlot,
        stdin: flags.stdin,
      },
      recipe,
      process.cwd(),
    );

    const result = await runRecipe({
      recipe,
      input,
      deps: {
        provider,
        providerName: alias,
        model,
        timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
        onEvent: (e) => {
          if (e.type === 'stage:end') {
            const detail = e.detail as { request?: unknown } | undefined;
            if (detail?.request) requests.push(detail.request);
          }
          if (!flags.trace || json) return;
          if (e.type === 'stage:start') process.stderr.write(`  → ${e.stage}\n`);
          if (e.type === 'stage:skip') process.stderr.write(`  ○ ${e.stage} (${String(e.detail ?? '')})\n`);
          if (e.type === 'stage:end') process.stderr.write(`  ✓ ${e.stage}\n`);
        },
      },
      options: { dryRun, timeoutMs: flags.timeout ? Number(flags.timeout) : undefined },
    });

    if (flags.printRequest) {
      process.stdout.write(JSON.stringify({ ok: true, agent: { id: recipe.id, role: recipe.role }, requests }, null, 2) + '\n');
      process.exit(0);
    }

    if (json) {
      process.stdout.write(renderJson(result) + '\n');
    } else if (flags.agent) {
      process.stdout.write(renderAgent(result) + '\n');
    } else if (flags.compact) {
      process.stdout.write(renderCompact(result) + '\n');
    } else {
      process.stdout.write(renderHuman(result) + '\n');
    }

    const code = dryRun ? EXIT.pass : EXIT[result.verdict];
    process.exit(code);
  } catch (e) {
    fail(e, json);
  }
}

export { loadCredentials };
