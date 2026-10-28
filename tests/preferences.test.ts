import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
};

let home: string;
let preferences: typeof import('../src/config/preferences.js');

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'm1-prefs-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // `homedir()` se resuelve en cada llamada, pero importamos después de aislar el env.
  preferences = await import('../src/config/preferences.js');
});

afterEach(() => {
  rmSync(preferences.preferencesPath(), { force: true });
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('preferencias de modelo', () => {
  it('guarda, lee y limpia por alias', () => {
    expect(preferences.loadPreferences()).toEqual({});
    expect(preferences.getPreferredModel('cf')).toBeUndefined();

    preferences.savePreferredModel('cf', '@cf/cloudflare/clef-omni');
    preferences.savePreferredModel('ts', 'jev-1.14.0');

    expect(preferences.loadPreferences()).toEqual({
      models: { cf: '@cf/cloudflare/clef-omni', ts: 'jev-1.14.0' },
    });
    expect(preferences.getPreferredModel('cf')).toBe('@cf/cloudflare/clef-omni');

    expect(preferences.clearPreferredModel('cf')).toBe(true);
    expect(preferences.clearPreferredModel('cf')).toBe(false);
    expect(preferences.loadPreferences()).toEqual({ models: { ts: 'jev-1.14.0' } });

    expect(preferences.clearPreferredModel('ts')).toBe(true);
    expect(preferences.loadPreferences()).toEqual({});
  });

  it('usa ~/.config/m1-agent/preferences.json con JSON legible', () => {
    const path = preferences.preferencesPath();
    expect(path.startsWith(home)).toBe(true);

    preferences.savePreferredModel('cf', 'clef-flash');

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { models?: Record<string, string> };
    expect(onDisk.models).toEqual({ cf: 'clef-flash' });
  });

  it('con JSON roto devuelve {} y agrega un warning (no explota)', () => {
    const path = preferences.preferencesPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ esto no es json');

    const warnings: string[] = [];
    expect(preferences.loadPreferences(warnings)).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('preferences.json');
  });

  it('ignora entradas que no son strings', () => {
    const path = preferences.preferencesPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ models: { cf: 42, ts: 'jev-latest', mock: '  ' } }));

    expect(preferences.loadPreferences()).toEqual({ models: { ts: 'jev-latest' } });
  });
});
