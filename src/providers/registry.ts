import { M1Error } from '../core/errors.js';
import { CLOUDFLARE_DEFAULT_MODEL, createCloudflareProvider } from './cloudflare.js';
import { createMockProvider, MOCK_DEFAULT_MODEL } from './mock.js';
import { createSystemOneProvider, SYSTEMONE_DEFAULT_MODEL } from './systemone.js';
import { createTypesafeProvider, TYPESAFE_DEFAULT_MODEL } from './typesafe.js';
import type { DecisionProvider, ProviderConfig, ProviderKind } from './types.js';

const VALID_KINDS: readonly ProviderKind[] = ['cloudflare', 'typesafe', 'systemone', 'mock'];

export function defaultModelFor(kind: ProviderKind): string {
  switch (kind) {
    case 'cloudflare':
      return CLOUDFLARE_DEFAULT_MODEL;
    case 'typesafe':
      return TYPESAFE_DEFAULT_MODEL;
    case 'systemone':
      return SYSTEMONE_DEFAULT_MODEL;
    case 'mock':
      return MOCK_DEFAULT_MODEL;
    default:
      throw new M1Error('E_CONFIG', `kind de provider desconocido: ${String(kind)}`, {
        hint: `kinds válidos: ${VALID_KINDS.join(', ')}`,
      });
  }
}

export type ModelSource = 'flag' | 'preference' | 'config' | 'default';

export interface EffectiveModel {
  model: string;
  source: ModelSource;
}

/**
 * Precedencia del modelo efectivo:
 * `--model` > preferencia de usuario > `provider.model` de la config > default del kind.
 */
export function resolveEffectiveModel(opts: {
  cfg: ProviderConfig;
  flagModel?: string;
  preferredModel?: string;
}): EffectiveModel {
  const flag = opts.flagModel?.trim();
  if (flag) return { model: flag, source: 'flag' };

  const preference = opts.preferredModel?.trim();
  if (preference) return { model: preference, source: 'preference' };

  const configured = opts.cfg.model?.trim();
  if (configured) return { model: configured, source: 'config' };

  return { model: defaultModelFor(opts.cfg.kind), source: 'default' };
}

export function createProvider(name: string, cfg: ProviderConfig): DecisionProvider {
  switch (cfg.kind) {
    case 'cloudflare':
      return createCloudflareProvider(name, cfg);
    case 'typesafe':
      return createTypesafeProvider(name, cfg);
    case 'systemone':
      return createSystemOneProvider(name, cfg);
    case 'mock':
      return createMockProvider(name, cfg);
    default:
      throw new M1Error('E_CONFIG', `kind de provider desconocido: ${String(cfg.kind)}`, {
        hint: `kinds válidos: ${VALID_KINDS.join(', ')}`,
      });
  }
}
