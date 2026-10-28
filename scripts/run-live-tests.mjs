#!/usr/bin/env node
/** Corre los tests live (red real) con M1_LIVE=1 de forma cross-platform. */
import { spawnSync } from 'node:child_process';

const result = spawnSync('pnpm', ['exec', 'vitest', 'run', 'tests/integration/*.live.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, M1_LIVE: '1' },
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
