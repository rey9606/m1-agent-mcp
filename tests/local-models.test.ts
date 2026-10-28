import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hfCacheDir,
  hfRepoDir,
  llamaModelArgs,
  parseHfSpec,
  planLlamaModel,
  resolveModelSource,
} from '../src/local/models.js';
import type { ProviderConfig } from '../src/providers/types.js';

const tmpDirs: string[] = [];
const originalEnv = {
  M1_HF_CACHE_DIR: process.env.M1_HF_CACHE_DIR,
  HF_HOME: process.env.HF_HOME,
};

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'm1-hf-'));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.M1_HF_CACHE_DIR = makeTmpDir();
  delete process.env.HF_HOME;
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalEnv.M1_HF_CACHE_DIR === undefined) delete process.env.M1_HF_CACHE_DIR;
  else process.env.M1_HF_CACHE_DIR = originalEnv.M1_HF_CACHE_DIR;
  if (originalEnv.HF_HOME === undefined) delete process.env.HF_HOME;
  else process.env.HF_HOME = originalEnv.HF_HOME;
});

function llamaCfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    kind: 'systemone',
    baseUrl: 'http://127.0.0.1:9931/v1/systemone',
    model: 'LiquidAI/d1-2B-GGUF:Q8_0',
    launch: { command: 'llama-server', args: [], port: 9931 },
    ...overrides,
  };
}

/** Crea `snapshots/<sha>/<file>` dentro de la caché HF aislada. */
function seedCache(repo: string, revision: string, files: string[]): string {
  const snapshot = join(hfCacheDir(), hfRepoDir({ repo }), 'snapshots', revision);
  mkdirSync(snapshot, { recursive: true });
  for (const file of files) writeFileSync(join(snapshot, file), 'gguf');
  return snapshot;
}

describe('hfCacheDir', () => {
  it('usa M1_HF_CACHE_DIR cuando está definido', () => {
    const dir = makeTmpDir();
    process.env.M1_HF_CACHE_DIR = dir;
    expect(hfCacheDir()).toBe(dir);
  });

  it('cae a HF_HOME/hub y si no al home del usuario', () => {
    delete process.env.M1_HF_CACHE_DIR;
    process.env.HF_HOME = join(tmpdir(), 'hf-home');
    expect(hfCacheDir()).toBe(join(tmpdir(), 'hf-home', 'hub'));

    delete process.env.HF_HOME;
    expect(hfCacheDir()).toMatch(/huggingface[\\/]hub$/);
  });
});

describe('parseHfSpec', () => {
  it('acepta org/repo y org/repo:quant', () => {
    expect(parseHfSpec('LiquidAI/d1-2B-GGUF')).toEqual({ repo: 'LiquidAI/d1-2B-GGUF' });
    expect(parseHfSpec('LiquidAI/d1-2B-GGUF:Q8_0')).toEqual({
      repo: 'LiquidAI/d1-2B-GGUF',
      quant: 'Q8_0',
    });
    expect(parseHfSpec('  LiquidAI/d1-3B-GGUF:Q4_K_M  ')).toEqual({
      repo: 'LiquidAI/d1-3B-GGUF',
      quant: 'Q4_K_M',
    });
  });

  it('rechaza rutas de archivo', () => {
    expect(parseHfSpec('C:\\models\\x.gguf')).toBeUndefined();
    expect(parseHfSpec('./x.gguf')).toBeUndefined();
    expect(parseHfSpec('x.gguf')).toBeUndefined();
    expect(parseHfSpec('../models/x.gguf')).toBeUndefined();
    expect(parseHfSpec('/abs/models/x.gguf')).toBeUndefined();
    expect(parseHfSpec('org/repo/x.gguf')).toBeUndefined();
    expect(parseHfSpec('C:/models/x.gguf')).toBeUndefined();
  });

  it('rechaza lo que no es exactamente org/repo[:quant]', () => {
    expect(parseHfSpec('')).toBeUndefined();
    expect(parseHfSpec('   ')).toBeUndefined();
    expect(parseHfSpec('d1-2B')).toBeUndefined();
    expect(parseHfSpec('org/repo/file')).toBeUndefined();
    expect(parseHfSpec('org/repo:')).toBeUndefined();
    expect(parseHfSpec('org/repo:Q8_0:extra')).toBeUndefined();
  });
});

describe('hfRepoDir', () => {
  it('usa models--org--repo', () => {
    expect(hfRepoDir({ repo: 'LiquidAI/d1-2B-GGUF' })).toBe('models--LiquidAI--d1-2B-GGUF');
    expect(hfRepoDir({ repo: 'org/repo' })).toBe('models--org--repo');
  });
});

describe('resolveModelSource', () => {
  it('marca el repo de HF como no cacheado y luego cacheado', () => {
    const cfg = llamaCfg();
    const before = resolveModelSource(cfg);
    expect(before).toEqual({
      mode: 'hf',
      repo: 'LiquidAI/d1-2B-GGUF',
      quant: 'Q8_0',
      cached: false,
    });

    const snapshot = seedCache('LiquidAI/d1-2B-GGUF', 'abc123', ['d1-2B-Q8_0.gguf']);
    const after = resolveModelSource(cfg);
    expect(after.mode).toBe('hf');
    if (after.mode !== 'hf') throw new Error('se esperaba modo hf');
    expect(after.cached).toBe(true);
    expect(after.cachePath).toBe(join(snapshot, 'd1-2B-Q8_0.gguf'));
  });

  it('prefiere el .gguf que coincide con la quant pedida', () => {
    const snapshot = seedCache('LiquidAI/d1-2B-GGUF', 'sha', [
      'd1-2B-Q4_K_M.gguf',
      'd1-2B-Q8_0.gguf',
    ]);

    const source = resolveModelSource(llamaCfg());
    if (source.mode !== 'hf') throw new Error('se esperaba modo hf');
    expect(source.cachePath).toBe(join(snapshot, 'd1-2B-Q8_0.gguf'));
  });

  it('sin quant toma cualquier .gguf del snapshot', () => {
    const snapshot = seedCache('LiquidAI/d1-3B-GGUF', 'sha', ['d1-3B-Q8_0.gguf']);
    const source = resolveModelSource(llamaCfg({ model: 'LiquidAI/d1-3B-GGUF' }));
    if (source.mode !== 'hf') throw new Error('se esperaba modo hf');
    expect(source.cached).toBe(true);
    expect(source.cachePath).toBe(join(snapshot, 'd1-3B-Q8_0.gguf'));
  });

  it('modo file para un .gguf del disco', () => {
    const dir = makeTmpDir();
    const path = join(dir, 'modelo.gguf');
    writeFileSync(path, 'gguf');

    expect(resolveModelSource(llamaCfg({ model: path }))).toEqual({
      mode: 'file',
      path,
      exists: true,
    });
    expect(
      resolveModelSource(llamaCfg({ model: join(dir, 'no-existe.gguf') })),
    ).toEqual({ mode: 'file', path: join(dir, 'no-existe.gguf'), exists: false });
  });

  it('none cuando launch.args ya elige el modelo', () => {
    const cfg = llamaCfg({
      launch: { command: 'llama-server', args: ['-m', 'C:/models/x.gguf'], port: 9931 },
    });
    expect(resolveModelSource(cfg)).toEqual({ mode: 'none' });

    const hf = llamaCfg({
      launch: { command: 'llama-server', args: ['--hf-repo', 'org/repo:Q8_0'], port: 9931 },
    });
    expect(resolveModelSource(hf)).toEqual({ mode: 'none' });
  });

  it('none sin modelo o con un alias que no es repo ni .gguf', () => {
    expect(resolveModelSource(llamaCfg({ model: undefined }))).toEqual({ mode: 'none' });
    expect(resolveModelSource(llamaCfg({ model: 'd1-omni-600M' }))).toEqual({ mode: 'none' });
  });
});

describe('args y plan', () => {
  it('llamaModelArgs arma -hf con quant y -m para archivos', () => {
    expect(
      llamaModelArgs({ mode: 'hf', repo: 'org/repo', quant: 'Q8_0', cached: false }),
    ).toEqual(['-hf', 'org/repo:Q8_0']);
    expect(llamaModelArgs({ mode: 'hf', repo: 'org/repo', cached: true })).toEqual([
      '-hf',
      'org/repo',
    ]);
    expect(llamaModelArgs({ mode: 'file', path: 'C:/x.gguf', exists: true })).toEqual([
      '-m',
      'C:/x.gguf',
    ]);
    expect(llamaModelArgs({ mode: 'none' })).toEqual([]);
  });

  it('planLlamaModel describe la descarga y el comando', () => {
    const plan = planLlamaModel(llamaCfg());
    expect(plan.source.mode).toBe('hf');
    expect(plan.needsDownload).toBe(true);
    expect(plan.hint).toContain('llama-server');
    expect(plan.hint).toContain('-hf LiquidAI/d1-2B-GGUF:Q8_0');
    expect(plan.hint).toContain('--port 9931');

    seedCache('LiquidAI/d1-2B-GGUF', 'sha', ['d1-2B-Q8_0.gguf']);
    expect(planLlamaModel(llamaCfg()).needsDownload).toBe(false);
  });

  it('planLlamaModel no marca descarga si hay args explícitos', () => {
    const plan = planLlamaModel(
      llamaCfg({
        launch: { command: 'llama-server', args: ['-m', 'C:/models/x.gguf'], port: 9931 },
      }),
    );
    expect(plan.source.mode).toBe('none');
    expect(plan.needsDownload).toBe(false);
  });
});