import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Integración real: CLI -> motor -> provider systemone -> servidor HTTP local.
 * Sin mocks del transporte ni del provider.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

interface CapturedRequest {
  model?: string;
  state?: unknown;
  questions: Record<string, { type: string; criteria?: Record<string, unknown> }>;
  images?: unknown[];
}

const RECIPE = {
  schema: 'm1agent/recipe@1',
  id: 'local-checker',
  role: 'tester de integración',
  input: { slots: { state: { type: 'text', required: true } } },
  criteria: [
    { id: 'L-1', type: 'noul', instructions: '¿El texto es claro?', passAt: 0.5, weight: 1, severity: 'blocker' },
    {
      id: 'L-2',
      type: 'score',
      instructions: 'Calificá la calidad',
      criteria: ['mala', 'media', 'buena'],
      passAt: 0.5,
      weight: 1,
      severity: 'major',
    },
  ],
  stages: [{ id: 's1', questions: ['L-1', 'L-2'], state: '{{state}}' }],
  acceptance: [{ id: 'A1', expr: 'L-1 >= 0.5', severity: 'blocker' }],
};

let server: Server;
let baseUrl: string;
let dir: string;
let configPath: string;
let recipePath: string;
let captured: CapturedRequest | undefined;
let failing = false;

function buildResponse(body: unknown): unknown {
  captured = body as CapturedRequest;
  const request = body as CapturedRequest;
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(request.questions ?? {})) {
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.9 };
    else if (question.type === 'score') {
      answers[id] = { type: 'score', score: 2, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 }, confidence: 0.9 };
    } else {
      const first = Object.keys(question.criteria ?? { ok: 1 })[0]!;
      answers[id] = { type: 'choice', choice: first, probabilities: { [first]: 1 }, confidence: 0.9 };
    }
  }
  return { model: 'fake-systemone', answers, usage: { input_tokens: 12, output_tokens: 3 } };
}

function cli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI, ...args], {
      cwd: REPO,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', rejectCli);
    child.on('close', (status) => resolveCli({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'm1-integration-'));
  recipePath = join(dir, 'local-checker.json');
  configPath = join(dir, 'm1.config.json');
  writeFileSync(recipePath, JSON.stringify(RECIPE));

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (failing) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('upstream caído');
        return;
      }
      const parsed = JSON.parse(body) as CapturedRequest;
      const payload = buildResponse(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1/systemone`;

  writeFileSync(
    configPath,
    JSON.stringify({
      default: 'local',
      providers: {
        local: { kind: 'systemone', baseUrl, model: 'fake-systemone', timeoutMs: 5000 },
      },
    }),
  );
});

afterAll(async () => {
  failing = false;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(dir, { recursive: true, force: true });
});

describe('integración systemone (HTTP real)', () => {
  it('corre la receta completa contra un endpoint compatible local', async () => {
    const result = await cli(['run', recipePath, '--state', 'texto de prueba', '--json', '-c', configPath]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);

    const out = JSON.parse(result.stdout) as {
      verdict: string;
      score: number;
      criteria: Array<{ id: string; normalized: number; passAt: number }>;
      meta: { provider: string; calls: number; model: string };
    };

    expect(out.verdict).toBe('pass');
    expect(out.score).toBeGreaterThanOrEqual(50);
    expect(out.meta.provider).toBe('local');
    expect(out.meta.model).toBe('fake-systemone');
    expect(out.meta.calls).toBe(1);
    expect(out.criteria.find((c) => c.id === 'L-1')).toMatchObject({ normalized: 0.9, passAt: 0.5 });

    expect(captured?.model).toBe('fake-systemone');
    expect(captured?.state).toBe('texto de prueba');
    expect(Object.keys(captured?.questions ?? {})).toEqual(['L-1', 'L-2']);
    expect(captured?.images).toBeUndefined();
  });

  it('propaga un 503 del endpoint como E_PROVIDER y exit 2', async () => {
    failing = true;
    const result = await cli(['run', recipePath, '--state', 'texto', '--json', '-c', configPath]);

    expect(result.status).toBe(2);
    const error = (JSON.parse(result.stderr) as { error: { code: string; message: string } }).error;
    expect(error.code).toBe('E_PROVIDER');
    expect(error.message).toContain('503');
  });
});

