import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { M1Error } from '../core/errors';
import type { LocalAutoStart, ProviderConfig } from '../providers/types';

export const DEFAULT_LOCAL_START_TIMEOUT_MS = 180_000;
export const DEFAULT_HEALTH_PATH = '/health';
export const DEFAULT_LOCAL_COMMAND = 'llama-server';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1']);

/** `true` para hosts loopback (incluye cualquier 127.0.0.0/8). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

export interface LocalEndpoint {
  origin: string;
  host: string;
  port: number;
  pathname: string;
}

export function parseLocalEndpoint(baseUrl: string): LocalEndpoint {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new M1Error('E_CONFIG', `baseUrl inválida: ${baseUrl}`, {
      hint: 'ej: "http://127.0.0.1:9931/v1/systemone"',
    });
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  return { origin: url.origin, host: url.hostname, port, pathname: url.pathname };
}

/** Reemplaza el puerto conservando host, path y query. */
export function withPort(baseUrl: string, port: number): string {
  const url = new URL(baseUrl);
  url.port = String(port);
  return url.toString();
}

/** Deriva `.../v1/models` desde `.../v1/systemone`. */
export function systemoneModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/systemone\/?$/i, '/models');
  if (!/\/models\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  }
  url.search = '';
  return url.toString();
}

function healthUrl(baseUrl: string, healthPath = DEFAULT_HEALTH_PATH): string {
  if (/^https?:\/\//i.test(healthPath)) return healthPath;
  const url = new URL(baseUrl);
  url.pathname = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;
  url.search = '';
  return url.toString();
}

export type LocalProbeState = 'running' | 'starting' | 'down' | 'foreign';

export interface LocalProbeResult {
  state: LocalProbeState;
  status?: number;
  detail?: string;
  /** Ids publicados por `/v1/models` (sólo cuando el servidor responde). */
  models?: string[];
}

export interface ProbeOptions {
  timeoutMs?: number;
  healthPath?: string;
  models?: boolean;
}

/** ¿Hay algo escuchando en host:port? */
export function isPortOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (open: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function readModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (typeof entry === 'object' && entry !== null) {
        const value = (entry as Record<string, unknown>).id;
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
      }
      return undefined;
    })
    .filter((value): value is string => value !== undefined);
}

/**
 * Sondea el endpoint local.
 * - `running`: `/health` responde 2xx.
 * - `starting`: `/health` responde 503 (llama.cpp mientras carga el modelo).
 * - `foreign`: hay algo escuchando pero no es el servidor esperado.
 * - `down`: nadie escucha.
 */
export async function probeLocal(baseUrl: string, options: ProbeOptions = {}): Promise<LocalProbeResult> {
  const endpoint = parseLocalEndpoint(baseUrl);
  const url = healthUrl(baseUrl, options.healthPath);
  const timeoutMs = options.timeoutMs ?? 1_500;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
  } catch {
    const open = await isPortOpen(endpoint.host, endpoint.port);
    return open
      ? { state: 'foreign', detail: 'el puerto está ocupado pero /health no responde' }
      : { state: 'down' };
  }

  const body = await response.text().catch(() => '');
  if (response.status === 503) {
    return { state: 'starting', status: 503, detail: body.slice(0, 200) || 'cargando modelo' };
  }
  if (!response.ok) {
    return {
      state: 'foreign',
      status: response.status,
      detail: `HTTP ${response.status} en ${url}`,
    };
  }

  let models: string[] | undefined;
  if (options.models !== false) {
    try {
      const listed = await fetch(systemoneModelsUrl(baseUrl), {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (listed.ok) models = readModelIds(await listed.json());
    } catch {
      /* el listado es opcional: el health ya confirma que está arriba */
    }
  }

  return { state: 'running', status: response.status, models };
}

export interface LaunchSpec {
  command: string;
  args: string[];
}

export function formatCommand(spec: LaunchSpec): string {
  const quote = (value: string): string =>
    /[\s"']/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
  return [spec.command, ...spec.args].map(quote).join(' ');
}

function replacePlaceholders(
  args: string[],
  values: { port: number; host: string; model?: string; baseUrl?: string },
): string[] {
  return args.map((arg) =>
    arg
      .replaceAll('{port}', String(values.port))
      .replaceAll('{host}', values.host)
      .replaceAll('{model}', values.model ?? '')
      .replaceAll('{baseUrl}', values.baseUrl ?? ''),
  );
}

function ensureFlag(args: string[], flag: string, value: string): void {
  const present = args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (!present) args.push(flag, value);
}

function isLlamaServer(command: string): boolean {
  return /(^|[\\/])llama-server(\.exe)?$/i.test(command);
}

/**
 * Construye el comando de arranque. Para `llama-server` garantiza `--port`,
 * `--host` y `--alias` (así `/v1/models` publica el id que usa la receta).
 */
export function buildLaunchSpec(
  cfg: ProviderConfig,
  opts: { port: number; host: string },
): LaunchSpec {
  const launch = cfg.launch;
  if (!launch) throw new M1Error('E_CONFIG', 'el provider no tiene configuración launch');
  const command = launch.command ?? DEFAULT_LOCAL_COMMAND;
  const args = replacePlaceholders(launch.args ?? [], {
    port: opts.port,
    host: opts.host,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
  });
  if (isLlamaServer(command)) {
    ensureFlag(args, '--port', String(opts.port));
    ensureFlag(args, '--host', opts.host);
    if (cfg.model) ensureFlag(args, '--alias', cfg.model);
  }
  return { command, args };
}

function safeAlias(alias: string): string {
  return alias.replace(/[^a-z0-9._-]+/gi, '_') || 'local';
}

export function localStateDir(): string {
  const override = process.env.M1_CACHE_DIR?.trim();
  return override ? join(override, 'local') : join(homedir(), '.cache', 'm1-agent', 'local');
}

function recordPath(alias: string, stateDir: string): string {
  return join(stateDir, `${safeAlias(alias)}.json`);
}

export interface LocalServerRecord {
  pid: number;
  port: number;
  baseUrl: string;
  command: string;
  args: string[];
  startedAt: string;
  logPath: string;
}

export function readLocalRecord(alias: string, stateDir = localStateDir()): LocalServerRecord | undefined {
  const path = recordPath(alias, stateDir);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LocalServerRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.baseUrl !== 'string') return undefined;
    return parsed as LocalServerRecord;
  } catch {
    return undefined;
  }
}

function writeLocalRecord(alias: string, stateDir: string, record: LocalServerRecord): void {
  mkdirSync(dirname(recordPath(alias, stateDir)), { recursive: true });
  writeFileSync(recordPath(alias, stateDir), JSON.stringify(record, null, 2), 'utf8');
}

export function removeLocalRecord(alias: string, stateDir = localStateDir()): boolean {
  const path = recordPath(alias, stateDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function tailLog(path: string | undefined, lines = 8): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const content = readFileSync(path, 'utf8').trimEnd().split(/\r?\n/u);
    return content.slice(-lines).join('\n');
  } catch {
    return undefined;
  }
}

export interface SpawnedServer {
  pid?: number;
  exitCode: number | null;
  kill: () => void;
}

export interface LocalRuntime {
  probe: (baseUrl: string, options?: ProbeOptions) => Promise<LocalProbeResult>;
  isPortOpen: (host: string, port: number) => Promise<boolean>;
  spawnServer: (spec: LaunchSpec, logPath: string) => SpawnedServer;
  confirm: (question: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  isAlive: (pid: number) => boolean;
}

function spawnServer(spec: LaunchSpec, logPath: string): SpawnedServer {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

async function confirmPrompt(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^(|y|yes|s|si|sí)$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const defaultLocalRuntime: LocalRuntime = {
  probe: probeLocal,
  isPortOpen,
  spawnServer,
  confirm: confirmPrompt,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  isAlive: isPidAlive,
};

function runtimeWith(overrides?: Partial<LocalRuntime>): LocalRuntime {
  return { ...defaultLocalRuntime, ...overrides };
}

/** Primer puerto libre desde `preferred` (hasta 50 intentos). */
export async function pickPort(
  host: string,
  preferred: number,
  runtime: Pick<LocalRuntime, 'isPortOpen'> = defaultLocalRuntime,
): Promise<number> {
  for (let port = preferred; port <= Math.min(65_535, preferred + 50); port += 1) {
    if (!(await runtime.isPortOpen(host, port))) return port;
  }
  throw new M1Error('E_PROVIDER', `no hay puertos libres desde ${preferred}`, {
    hint: 'liberá un puerto o configurá provider.launch.port',
  });
}

export interface EnsureLocalOptions {
  alias: string;
  cfg: ProviderConfig;
  /** Override de la política (`--local-start`). */
  autoStart?: LocalAutoStart;
  /** Sólo se pregunta si el proceso corre en una TTY interactiva. */
  interactive: boolean;
  onStatus?: (line: string) => void;
  stateDir?: string;
  runtime?: Partial<LocalRuntime>;
}

export interface EnsureLocalResult {
  baseUrl: string;
  started: boolean;
  port?: number;
  logPath?: string;
  warnings: string[];
}

function notRunningError(
  baseUrl: string,
  spec: LaunchSpec | undefined,
  reason = 'el modelo local no responde',
): M1Error {
  return new M1Error('E_PROVIDER', `${reason}: ${baseUrl}`, {
    hint: spec
      ? `levantalo con: ${formatCommand(spec)}`
      : 'levantá el servidor local o agregá provider.launch a la config',
  });
}

function modelWarnings(probe: LocalProbeResult, model: string | undefined): string[] {
  if (!model || !probe.models || probe.models.length === 0) return [];
  if (probe.models.includes(model)) return [];
  return [
    `el servidor local no expone el modelo "${model}" (expone: ${probe.models.join(', ')})`,
  ];
}

interface WaitOptions {
  baseUrl: string;
  healthPath?: string;
  timeoutMs: number;
  runtime: LocalRuntime;
  child?: SpawnedServer;
  logPath?: string;
}

async function waitForReady(options: WaitOptions): Promise<void> {
  const deadline = options.runtime.now() + options.timeoutMs;
  while (options.runtime.now() < deadline) {
    if (options.child && options.child.exitCode !== null) {
      throw new M1Error('E_PROVIDER', `el servidor local terminó con código ${options.child.exitCode}`, {
        hint: `revisá el log: ${options.logPath ?? '(sin log)'}`,
        details: tailLog(options.logPath),
      });
    }
    const probe = await options.runtime.probe(options.baseUrl, {
      healthPath: options.healthPath,
      timeoutMs: 1_000,
      models: false,
    });
    if (probe.state === 'running') return;
    await options.runtime.sleep(400);
  }
  throw new M1Error('E_TIMEOUT', `el servidor local no quedó listo en ${options.timeoutMs} ms`, {
    hint: `revisá el log: ${options.logPath ?? '(sin log)'}`,
    details: tailLog(options.logPath),
  });
}

async function startAndWait(
  options: EnsureLocalOptions & {
    runtime: LocalRuntime;
    stateDir: string;
    port: number;
    host: string;
  },
): Promise<EnsureLocalResult> {
  const { alias, cfg, runtime, stateDir, onStatus } = options;
  const baseUrl = cfg.baseUrl ?? '';
  const logPath = join(stateDir, 'logs', `${safeAlias(alias)}.log`);
  const spec = buildLaunchSpec(cfg, { port: options.port, host: options.host });
  const runtimeBase = withPort(baseUrl, options.port);

  onStatus?.(`levantando ${spec.command} en ${options.host}:${options.port}`);
  onStatus?.(`log: ${logPath}`);

  let child: SpawnedServer;
  try {
    child = runtime.spawnServer(spec, logPath);
  } catch (error) {
    throw new M1Error('E_PROVIDER', `no se pudo ejecutar "${spec.command}"`, {
      hint: '¿está instalado y en el PATH?',
      cause: error,
    });
  }

  try {
    await waitForReady({
      baseUrl: runtimeBase,
      healthPath: cfg.launch?.healthPath,
      timeoutMs: cfg.launch?.startTimeoutMs ?? DEFAULT_LOCAL_START_TIMEOUT_MS,
      runtime,
      child,
      logPath,
    });
  } catch (error) {
    try {
      child.kill();
    } catch {
      /* best effort */
    }
    throw error;
  }

  if (child.pid !== undefined) {
    writeLocalRecord(alias, stateDir, {
      pid: child.pid,
      port: options.port,
      baseUrl: runtimeBase,
      command: spec.command,
      args: spec.args,
      startedAt: new Date().toISOString(),
      logPath,
    });
  }

  const ready = await runtime.probe(runtimeBase, { healthPath: cfg.launch?.healthPath });
  return {
    baseUrl: runtimeBase,
    started: true,
    port: options.port,
    logPath,
    warnings: modelWarnings(ready, cfg.model),
  };
}

/**
 * Garantiza un endpoint local disponible.
 *
 * 1. Si ya responde, lo usa.
 * 2. Si hay un servidor registrado (aunque sea en otro puerto), lo reutiliza.
 * 3. Si no, aplica la política (`ask` pregunta en TTY) y arranca en el primer
 *    puerto libre desde `launch.port` (así no choca con otro proceso).
 */
export async function ensureLocalEndpoint(options: EnsureLocalOptions): Promise<EnsureLocalResult> {
  const { cfg } = options;
  if (cfg.kind !== 'systemone' || !cfg.launch || !cfg.baseUrl) {
    return { baseUrl: cfg.baseUrl ?? '', started: false, warnings: [] };
  }

  const runtime = runtimeWith(options.runtime);
  const stateDir = options.stateDir ?? localStateDir();
  const baseUrl = cfg.baseUrl;
  const launch = cfg.launch;
  const endpoint = parseLocalEndpoint(baseUrl);

  const initial = await runtime.probe(baseUrl, { healthPath: launch.healthPath });
  if (initial.state === 'running') {
    return {
      baseUrl,
      started: false,
      port: endpoint.port,
      warnings: modelWarnings(initial, cfg.model),
    };
  }

  const record = readLocalRecord(options.alias, stateDir);
  if (record) {
    if (!runtime.isAlive(record.pid)) {
      removeLocalRecord(options.alias, stateDir);
    } else if (record.baseUrl !== baseUrl) {
      const adopted = await runtime.probe(record.baseUrl, { healthPath: launch.healthPath });
      if (adopted.state === 'running') {
        return {
          baseUrl: record.baseUrl,
          started: false,
          port: record.port,
          logPath: record.logPath,
          warnings: [
            `reutilizando el servidor local ya levantado en ${record.baseUrl}`,
            ...modelWarnings(adopted, cfg.model),
          ],
        };
      }
    } else {
      // Mismo endpoint y el proceso sigue vivo: probablemente está cargando.
      try {
        await waitForReady({
          baseUrl,
          healthPath: launch.healthPath,
          timeoutMs: launch.startTimeoutMs ?? DEFAULT_LOCAL_START_TIMEOUT_MS,
          runtime,
        });
        const ready = await runtime.probe(baseUrl, { healthPath: launch.healthPath });
        if (ready.state === 'running') {
          return {
            baseUrl,
            started: false,
            port: endpoint.port,
            logPath: record.logPath,
            warnings: modelWarnings(ready, cfg.model),
          };
        }
      } catch {
        /* el registro quedó viejo: se intenta arrancar de nuevo */
      }
      removeLocalRecord(options.alias, stateDir);
    }
  }

  const preferredPort = launch.port ?? endpoint.port;
  const policy = options.autoStart ?? launch.autoStart ?? 'ask';
  const candidate = buildLaunchSpec(cfg, { port: preferredPort, host: endpoint.host });

  if (policy === 'never') {
    throw notRunningError(baseUrl, candidate, 'el modelo local no responde y autoStart=never');
  }

  if (policy === 'ask' && !options.interactive) {
    throw notRunningError(
      baseUrl,
      candidate,
      'el modelo local no responde y no hay TTY para preguntar',
    );
  }

  const port = await pickPort(endpoint.host, preferredPort, runtime);

  if (policy === 'ask') {
    const spec = buildLaunchSpec(cfg, { port, host: endpoint.host });
    const accepted = await runtime.confirm(
      `El modelo local no responde en ${baseUrl}. ¿Levanto ${spec.command} en el puerto ${port}? [Y/n] `,
    );
    if (!accepted) {
      throw new M1Error('E_PROVIDER', 'arranque del modelo local cancelado', {
        hint: `para levantarlo manualmente: ${formatCommand(spec)}`,
      });
    }
  }

  return startAndWait({
    ...options,
    runtime,
    stateDir,
    port,
    host: endpoint.host,
  });
}

export interface LocalStatus {
  provider: string;
  baseUrl: string;
  state: LocalProbeState;
  port: number;
  logPath?: string;
  record?: LocalServerRecord;
}

/** Estado del endpoint local sin arrancar nada. */
export async function localStatus(
  alias: string,
  cfg: ProviderConfig,
  deps: { stateDir?: string; runtime?: Partial<LocalRuntime> } = {},
): Promise<LocalStatus> {
  if (!cfg.baseUrl) {
    throw new M1Error('E_CONFIG', `el provider "${alias}" no tiene baseUrl`);
  }
  const runtime = runtimeWith(deps.runtime);
  const stateDir = deps.stateDir ?? localStateDir();
  const record = readLocalRecord(alias, stateDir);

  if (record && !runtime.isAlive(record.pid)) {
    removeLocalRecord(alias, stateDir);
  }

  const target = record && runtime.isAlive(record.pid) ? record.baseUrl : cfg.baseUrl;
  const probe = await runtime.probe(target, { healthPath: cfg.launch?.healthPath });
  return {
    provider: alias,
    baseUrl: target,
    state: probe.state,
    port: parseLocalEndpoint(target).port,
    ...(record?.logPath !== undefined ? { logPath: record.logPath } : {}),
    ...(record !== undefined ? { record } : {}),
  };
}

export interface StopResult {
  stopped: boolean;
  pid?: number;
  reason?: string;
}

/** Detiene el servidor registrado para un alias (si sigue vivo). */
export function stopLocalServer(alias: string, stateDir = localStateDir()): StopResult {
  const record = readLocalRecord(alias, stateDir);
  if (!record) return { stopped: false, reason: 'no hay un servidor local registrado' };

  if (!isPidAlive(record.pid)) {
    removeLocalRecord(alias, stateDir);
    return { stopped: false, pid: record.pid, reason: 'el proceso ya no está corriendo' };
  }

  try {
    process.kill(record.pid);
  } catch (error) {
    return {
      stopped: false,
      pid: record.pid,
      reason: `no se pudo terminar el proceso: ${(error as Error).message}`,
    };
  }
  removeLocalRecord(alias, stateDir);
  return { stopped: true, pid: record.pid };
}
