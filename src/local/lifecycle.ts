import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { M1Error } from '../core/errors';
import type { LocalAutoStart, ProviderConfig } from '../providers/types';
import {
  hfRepoPath,
  llamaModelArgs,
  modelLabel,
  resolveModelSource,
} from './models';
import type { ModelSource } from './models';

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
  /** Puerto efectivo (para descubrir el PID por socket en modo consola). */
  port?: number;
  /** Abrir una consola propia para el servidor. */
  console?: boolean;
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
 *
 * Si `launch.args` no elige el modelo (`-m`, `--model`, `-hf`, `--hf-repo`),
 * se agrega el que sale de `provider.model` (repo de HF o `.gguf` local) y el
 * `--mmproj` de `launch.mmproj`. Los args explícitos siempre mandan.
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
    args.push(...llamaModelArgs(resolveModelSource(cfg)));
    if (launch.mmproj) ensureFlag(args, '--mmproj', launch.mmproj);
    ensureFlag(args, '--port', String(opts.port));
    ensureFlag(args, '--host', opts.host);
    if (cfg.model) ensureFlag(args, '--alias', cfg.model);
  }
  return {
    command,
    args,
    port: opts.port,
    console: launch.console ?? process.platform === 'win32',
  };
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
  spawnServer: (spec: LaunchSpec, logPath: string) => SpawnedServer | Promise<SpawnedServer>;
  confirm: (question: string) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  isAlive: (pid: number) => boolean;
}

/**
 * Script que lanza el servidor detached y escribe su PID.
 *
 * Se ejecuta con `process.execPath` (node), no con el runner actual. Así el
 * servidor queda en un grupo de procesos distinto y sobrevive aunque la CLI
 * corra bajo `tsx` (que mata su árbol de procesos al salir).
 */
const SPAWN_HELPER = `import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';

const [logPath, pidPath, command, ...args] = process.argv.slice(2);
let fd;
try {
  fd = openSync(logPath, 'a');
  const child = spawn(command, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error('spawn no devolvió un pid');
  writeFileSync(pidPath, String(child.pid));
  child.unref();
} catch (error) {
  try {
    appendFileSync(logPath, \`[m1] no se pudo lanzar \${command}: \${String((error && error.stack) || error)}\\n\`);
  } catch {
    /* sin log tampoco podemos hacer nada */
  }
  process.exitCode = 1;
} finally {
  if (fd !== undefined) closeSync(fd);
}
`;

function quoteWindows(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/**
 * Lanza el helper con WMI (`Win32_Process.Create`).
 *
 * En Windows, `pnpm run`/`pnpm exec` matan el árbol de procesos al salir, y
 * `detached` no alcanza: el proceso creado por WmiPrvSE no pertenece a ese job.
 * Devuelve `false` si WMI no está disponible (se usa el spawn directo).
 */
function launchViaWmi(command: string, args: string[]): boolean {
  return launchRawViaWmi([command, ...args].map(quoteWindows).join(' '));
}

/** Como `launchViaWmi`, pero recibe la línea de comandos ya armada. */
function launchRawViaWmi(commandLine: string): boolean {
  if (process.platform !== 'win32') return false;
  const script = [
    "$ProgressPreference='SilentlyContinue'",
    "$ErrorActionPreference='Stop'",
    'try {',
    "  $p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:M1_LAUNCH_CMDLINE; CurrentDirectory = $env:M1_LAUNCH_CWD }",
    '  if ($p.ReturnValue -ne 0) { [Console]::Error.WriteLine("WMI return " + $p.ReturnValue); exit 1 }',
    '  [Console]::Out.WriteLine($p.ProcessId)',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, M1_LAUNCH_CMDLINE: commandLine, M1_LAUNCH_CWD: process.cwd() },
    },
  );
  return result.status === 0;
}

/**
 * Lanza el servidor en una consola propia (minimizada).
 *
 * Usa `start` (crea consola nueva) a través de WMI, así el proceso no pertenece
 * al job de `pnpm`/`tsx` y sobrevive a la CLI. Los logs van al archivo vía
 * `--log-file` (llama.cpp) para no perderlos aunque la ventana se cierre.
 */
function launchInConsole(spec: LaunchSpec, logPath: string): boolean {
  if (process.platform !== 'win32') return false;
  const args = [...spec.args];
  if (isLlamaServer(spec.command)) {
    const hadLogFile = args.some((arg) => arg === '--log-file' || arg.startsWith('--log-file='));
    ensureFlag(args, '--log-file', logPath);
    // Sin esto, el server detecta consola y mete secuencias ANSI en el archivo.
    if (!hadLogFile) ensureFlag(args, '--log-colors', 'off');
  }
  const title = `m1 ${basename(spec.command)}${spec.port ? ` :${spec.port}` : ''}`.replaceAll('"', '');
  const commandLine = `cmd.exe /c start "${title}" /min ${[spec.command, ...args]
    .map(quoteWindows)
    .join(' ')}`;
  return launchRawViaWmi(commandLine);
}

/** PID que escucha en `port` (Windows). Sirve cuando el arranque no expone el pid. */
function findListeningPid(port: number): number | undefined {
  if (process.platform !== 'win32') return undefined;
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!/LISTENING/iu.test(line)) continue;
    const cols = line.trim().split(/\s+/u);
    const local = cols[1] ?? '';
    const pid = Number.parseInt(cols[cols.length - 1] ?? '', 10);
    if (local.endsWith(`:${port}`) && Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}

async function waitForListeningPid(
  port: number,
  timeoutMs = 3_000,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = findListeningPid(port);
    if (pid !== undefined) return pid;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

function killProcessTree(pid: number): boolean {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15_000,
    });
    if (result.status === 0) return true;
  }
  try {
    process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

async function readSpawnedPid(pidPath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      /* el helper todavía no escribió el pid */
    }
    if (Date.now() >= deadline) return 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function spawnServer(spec: LaunchSpec, logPath: string): Promise<SpawnedServer> {
  mkdirSync(dirname(logPath), { recursive: true });

  if (spec.console && launchInConsole(spec, logPath)) {
    return {
      exitCode: null,
      kill: () => {
        const pid = spec.port !== undefined ? findListeningPid(spec.port) : undefined;
        if (pid !== undefined) killProcessTree(pid);
      },
    };
  }

  const dir = dirname(logPath);
  const helperPath = join(dir, '.m1-spawn-helper.mjs');
  writeFileSync(helperPath, SPAWN_HELPER, 'utf8');

  const pidPath = join(dir, `.m1-${basename(logPath)}-${process.pid}-${Date.now()}.pid`);
  const helperArgs = [helperPath, logPath, pidPath, spec.command, ...spec.args];

  const viaWmi = launchViaWmi(process.execPath, helperArgs);
  let status: number | null = 0;
  if (!viaWmi) {
    const result = spawnSync(process.execPath, helperArgs, {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
    });
    status = result.status;
  }

  const pid = await readSpawnedPid(pidPath, viaWmi ? 30_000 : 5_000);
  rmSync(pidPath, { force: true });

  if (pid <= 0) {
    throw new M1Error('E_PROVIDER', `no se pudo ejecutar "${spec.command}"`, {
      hint: '¿está instalado y en el PATH?',
      details: `revisá el log: ${logPath}${status !== 0 ? ` (helper exit ${status ?? 'null'})` : ''}`,
    });
  }

  return {
    pid,
    exitCode: null,
    kill: () => {
      try {
        process.kill(pid);
      } catch {
        /* ya no está */
      }
    },
  };
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
  /** `--download`: acepta bajar el modelo de HuggingFace sin preguntar. */
  download?: boolean;
  onStatus?: (line: string) => void;
  stateDir?: string;
  runtime?: Partial<LocalRuntime>;
}

/** Estado del modelo de un `llama-server` (para `m1 local status`). */
export interface LocalModelStatus {
  mode: 'hf' | 'file';
  /** Repo de HF (`org/repo[:quant]`) o la ruta del `.gguf`. */
  spec?: string;
  /** `true` si ya está en la caché / disco. */
  present: boolean;
  path?: string;
}

export interface EnsureLocalResult {
  baseUrl: string;
  started: boolean;
  port?: number;
  /** PID del servidor (en modo consola se descubre por el puerto). */
  pid?: number;
  logPath?: string;
  model?: LocalModelStatus;
  warnings: string[];
}

/** Modelo configurado en `provider.model`, sólo para `llama-server`. */
export function modelStatus(cfg: ProviderConfig): LocalModelStatus | undefined {
  const launch = cfg.launch;
  if (!launch) return undefined;
  if (!isLlamaServer(launch.command ?? DEFAULT_LOCAL_COMMAND)) return undefined;

  const source = resolveModelSource(cfg);
  return describeModelSource(source);
}

function describeModelSource(source: ModelSource): LocalModelStatus | undefined {
  if (source.mode === 'hf') {
    return {
      mode: 'hf',
      spec: modelLabel(source),
      present: source.cached,
      ...(source.cachePath !== undefined ? { path: source.cachePath } : {}),
    };
  }
  if (source.mode === 'file') {
    return { mode: 'file', spec: source.path, present: source.exists, path: source.path };
  }
  return undefined;
}

function downloadDetails(source: ModelSource): { model?: string; cachePath?: string } | undefined {
  if (source.mode !== 'hf') return undefined;
  return { model: modelLabel(source), cachePath: source.cachePath ?? hfRepoPath(source) };
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
    if (
      options.child?.exitCode === null &&
      options.child.pid !== undefined &&
      !options.runtime.isAlive(options.child.pid)
    ) {
      throw new M1Error('E_PROVIDER', 'el servidor local terminó antes de quedar listo', {
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
    child = await runtime.spawnServer(spec, logPath);
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

  const pid = child.pid ?? (await waitForListeningPid(options.port));
  if (pid !== undefined) {
    writeLocalRecord(alias, stateDir, {
      pid,
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
    ...(pid !== undefined ? { pid } : {}),
    logPath,
    warnings: modelWarnings(ready, cfg.model),
  };
}

/**
 * Si el modelo de HF no está cacheado, pregunta (TTY) o falla con el comando
 * exacto. Con `--download` sigue: `llama-server -hf` descarga y cachea solo.
 */
async function confirmModelDownload(
  options: EnsureLocalOptions,
  cfg: ProviderConfig,
  runtime: LocalRuntime,
): Promise<void> {
  if (!isLlamaServer(cfg.launch?.command ?? DEFAULT_LOCAL_COMMAND)) return;

  const source = resolveModelSource(cfg);
  if (source.mode !== 'hf' || source.cached) return;
  if (options.download === true) return;

  const label = modelLabel(source) ?? source.repo;
  const hint = `m1 local start --provider ${options.alias} --download`;
  const details = downloadDetails(source);

  if (!options.interactive) {
    throw new M1Error('E_PROVIDER', `el modelo ${label} no está descargado`, {
      hint,
      details,
    });
  }

  const accepted = await runtime.confirm(
    `El modelo ${label} no está descargado. ¿Descargarlo ahora? [y/N] `,
  );
  if (!accepted) {
    throw new M1Error('E_PROVIDER', 'descarga cancelada', { hint, details });
  }
}

/**
 * Garantiza un endpoint local disponible.
 *
 * 1. Si ya responde, lo usa.
 * 2. Si hay un servidor registrado (aunque sea en otro puerto), lo reutiliza.
 * 3. Si no, aplica la política (`ask` pregunta en TTY) y arranca en el primer
 *    puerto libre desde `launch.port` (así no choca con otro proceso).
 *
 * Antes de arrancar, si el modelo de HF no está cacheado y no vino
 * `download: true`, pregunta o falla (E_PROVIDER) en vez de bajar GBs de
 * sorpresa.
 */
export async function ensureLocalEndpoint(options: EnsureLocalOptions): Promise<EnsureLocalResult> {
  const result = await ensureLocalEndpointInner(options);
  const model = modelStatus(options.cfg);
  return model ? { ...result, model } : result;
}

async function ensureLocalEndpointInner(options: EnsureLocalOptions): Promise<EnsureLocalResult> {
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
    const running = readLocalRecord(options.alias, stateDir);
    return {
      baseUrl,
      started: false,
      port: endpoint.port,
      ...(running && runtime.isAlive(running.pid) ? { pid: running.pid } : {}),
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
  const policy = options.autoStart ?? launch.autoStart ?? 'always';
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

  // El modelo se chequea acá: si falta, se pregunta antes de levantar nada.
  await confirmModelDownload(options, cfg, runtime);

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
  /** Sólo `llama-server` con modelo configurado. */
  model?: LocalModelStatus;
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
  const model = modelStatus(cfg);
  return {
    provider: alias,
    baseUrl: target,
    state: probe.state,
    port: parseLocalEndpoint(target).port,
    ...(record?.logPath !== undefined ? { logPath: record.logPath } : {}),
    ...(record !== undefined ? { record } : {}),
    ...(model !== undefined ? { model } : {}),
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
    if (!killProcessTree(record.pid)) {
      return {
        stopped: false,
        pid: record.pid,
        reason: 'no se pudo terminar el proceso',
      };
    }
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
