import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { M1Error } from '../../core/errors';
import { runRecipe } from '../../core/engine';
import { validateRecipe } from '../../core/validate';
import { loadConfig, resolveProvider } from '../../config/config';
import { resolveSecrets, loadCredentials } from '../../config/credentials';
import { createProvider, defaultModelFor } from '../../providers/registry';
import { buildRunInput } from '../io';
import { EXIT, fail } from '../output';
import { renderHuman } from '../../render/human';
import { renderJson } from '../../render/json';
import { renderCompact } from '../../render/compact';
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
  trace?: boolean;
  dryRun?: boolean;
  provider?: string;
  model?: string;
  config?: string;
  timeout?: string;
}

async function loadRecipeFile(path: string) {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    throw new M1Error('E_INPUT', `no se pudo leer la receta: ${abs}`, { hint: 'pasá la ruta a un archivo .json' });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new M1Error('E_VALIDATION', `la receta no es JSON válido: ${abs}`, { hint: 'revisá comas y comillas', cause: e });
  }
  return validateRecipe(raw, { filePath: abs, defaultId: basename(abs).replace(/\.json$/i, '') });
}

const dryProvider: DecisionProvider = {
  name: 'dry-run',
  kind: 'mock',
  evaluate: async () => {
    throw new M1Error('E_PROVIDER', 'dry-run no ejecuta llamadas');
  },
};

export async function runCommand(recipePath: string, flags: RunFlags): Promise<never> {
  const json = Boolean(flags.json);
  try {
    const { recipe, warnings } = await loadRecipeFile(recipePath);
    if (!json && warnings.length > 0) {
      for (const w of warnings) process.stderr.write(`  ! ${w}\n`);
    }

    const config = loadConfig({ explicit: flags.config });
    const { alias, config: providerCfg } = resolveProvider(config, flags.provider, {
      model: flags.model,
      timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    });

    let provider: DecisionProvider;
    let model: string;
    if (flags.dryRun) {
      provider = dryProvider;
      model = providerCfg.model ?? defaultModelFor(providerCfg.kind);
    } else {
      const secrets = resolveSecrets(alias, providerCfg);
      const merged = {
        ...providerCfg,
        apiKey: providerCfg.apiKey ?? secrets.apiKey,
        accountId: providerCfg.accountId ?? secrets.accountId,
      };
      provider = createProvider(alias, merged);
      model = merged.model ?? defaultModelFor(merged.kind);
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
          if (!flags.trace || json) return;
          if (e.type === 'stage:start') process.stderr.write(`  → ${e.stage}\n`);
          if (e.type === 'stage:skip') process.stderr.write(`  ○ ${e.stage} (${String(e.detail ?? '')})\n`);
          if (e.type === 'stage:end') process.stderr.write(`  ✓ ${e.stage}\n`);
        },
      },
      options: { dryRun: Boolean(flags.dryRun), timeoutMs: flags.timeout ? Number(flags.timeout) : undefined },
    });

    if (json) {
      process.stdout.write(renderJson(result) + '\n');
    } else if (flags.compact) {
      process.stdout.write(renderCompact(result) + '\n');
    } else {
      process.stdout.write(renderHuman(result) + '\n');
    }

    const code = flags.dryRun ? EXIT.pass : EXIT[result.verdict];
    process.exit(code);
  } catch (e) {
    fail(e, json);
  }
}

export { loadCredentials };
