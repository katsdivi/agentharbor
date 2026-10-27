import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { ProxyMode } from '../../actor/src/protocol.js';
import { EXECUTION_MODES, type ExecutionMode } from './modes.js';

/** Repo/plugin root: dist/src/core/config.js -> three levels up. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface AuthorizedTarget {
  /** Origin where accounts live, e.g. https://app.example.com */
  origin: string;
  /** Additional origins used by the target's login/verification flow. */
  authOrigins: string[];
}

export interface Config {
  envFile: string | null;
  dataDir: string;
  apify: {
    token: string | null;
    actorId: string | null;
    /** Optional Actor build tag or number to pin (default: the Actor's latest build). */
    build: string | null;
    apiBaseUrl: string;
    workerMemoryMb: number;
    /** USD per compute unit used for *estimates* only. */
    cuPriceUsd: number;
    residentialGbPriceUsd: number;
    /** GB of residential traffic reserved (and enforced) per residential session. */
    residentialReserveGb: number;
  };
  mailslurp: {
    apiKey: string | null;
    apiBaseUrl: string;
    /** 0 = permanent inbox. */
    inboxExpiresHours: number;
    useDomainPool: boolean;
    maxInboxesPerMonth: number;
    maxEmailsPerMonth: number;
  };
  encryptionKey: Buffer | null;
  targets: AuthorizedTarget[];
  /**
   * Top-level navigation origins for sessions not bound to an account. Empty by
   * default (such sessions cannot navigate until configured); ['*'] = any public
   * origin, only when set explicitly.
   */
  allowedOrigins: string[];
  /**
   * Extra origins pages may load resources from (frames, scripts, images,
   * fetch/XHR, WebSockets, redirects of those). Navigation origins are always
   * included. Entries: exact origins, `https://*.example.com`, or '*' (explicit only).
   */
  subresourceOrigins: string[];
  allowPrivateHosts: string[];
  /**
   * RBA_LOCAL_RECORD_VIDEO_DIR: when set, workers of execution mode `local` record
   * a video of every page (Playwright recordVideo, 1920x1080) into this directory.
   * Off by default; remote workers never record.
   */
  localRecordVideoDir: string | null;
  proxy: { defaultMode: ProxyMode; country: string | null };
  /** RBA_DEFAULT_EXECUTION_MODE; null = derived from RBA_DEFAULT_PROXY_MODE (remote_direct for existing installs). */
  defaultExecutionMode: ExecutionMode | null;
  egressCheckUrl: string;
  limits: {
    monthlyBudgetUsd: number;
    maxConcurrentSessions: number;
    maxSessionMinutes: number;
    idleTimeoutSecs: number;
    maxCrawlPages: number;
    maxCrawlDepth: number;
    maxRetries: number;
    emailWaitMaxSecs: number;
    maxUploadBytes: number;
    leaseTtlSecs: number;
  };
  uploadRoots: string[];
  files: {
    /** Folders file_import may read from (realpath-checked). Empty = only the dashboard picker. */
    importRoots: string[];
    maxImportBytes: number;
    /** Decoded-size cap for images (width x height), checked from headers before any decode. */
    maxImagePixels: number;
    /** Wall-clock limit for one external tool run (ffmpeg, poppler). */
    toolTimeoutMs: number;
  };
  retention: { logDays: number; artifactDays: number };
  dashboard: { port: number; token: string | null };
  /** RBA_DISPLAY_NAME: human-readable label (MCP server title, dashboard). Never the plugin id. */
  displayName: string;
  /** Saved read operations (RBA_OPERATIONS_ENABLED, default off). See src/operations/. */
  operations: { enabled: boolean };
}

/** Variables the plugin reads. Used by check-config and .env.example. */
export const ENV_VARS = {
  required: ['APIFY_TOKEN', 'APIFY_ACTOR_ID', 'MAILSLURP_API_KEY', 'RBA_ENCRYPTION_KEY'],
  generated: ['RBA_ENCRYPTION_KEY', 'RBA_DASHBOARD_TOKEN'],
} as const;

const PLACEHOLDER = /^(|replace[_-]?me.*|changeme|<.*>|your[_-].*|xxx+|todo)$/i;

export function isPlaceholder(v: string | undefined | null): boolean {
  return v === undefined || v === null || PLACEHOLDER.test(v.trim());
}

/**
 * .env locations in priority order. RBA_ENV_FILE is explicit; $CLAUDE_PLUGIN_DATA/.env
 * survives plugin updates (new installs); the plugin root / project root .env are the
 * legacy in-place locations, which keep working unchanged.
 */
export function envFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const user = userConfigDir(env);
  return [
    env.RBA_ENV_FILE,
    env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, '.env') : undefined,
    user ? join(user, '.env') : undefined,
    env.CLAUDE_PLUGIN_ROOT ? join(env.CLAUDE_PLUGIN_ROOT, '.env') : undefined,
    join(PROJECT_ROOT, '.env'),
  ].filter((p): p is string => !!p);
}

/**
 * Per-user configuration folder OUTSIDE the plugin folder:
 * $RBA_CONFIG_HOME, else $XDG_CONFIG_HOME/remote-browser-accounts, else ~/.config/remote-browser-accounts.
 * Claude Code copies the whole plugin folder (including .env and data/) into its plugin cache
 * on install/update, so secrets and state must not live in the plugin folder. Unlike
 * $CLAUDE_PLUGIN_DATA this folder is not removed when the plugin is uninstalled.
 * Derived only from `env` (never os.homedir()), so tests with a synthetic env never see a real install.
 */
export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.RBA_CONFIG_HOME) return resolve(env.RBA_CONFIG_HOME);
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'remote-browser-accounts');
  if (env.HOME) return join(env.HOME, '.config', 'remote-browser-accounts');
  return null;
}

export function findEnvFile(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const c of envFileCandidates(env)) if (existsSync(c)) return c;
  return null;
}

/** Merge .env file values under real environment variables (real env wins). */
export function readEnv(env: NodeJS.ProcessEnv = process.env): { vars: Record<string, string | undefined>; file: string | null } {
  const file = findEnvFile(env);
  const fromFile = file ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {};
  return { vars: { ...fromFile, ...env }, file };
}

function str(v: string | undefined): string | null {
  return isPlaceholder(v) ? null : v!.trim();
}
function num(v: string | undefined, def: number, min: number, max: number, name = 'numeric variable'): number {
  if (isPlaceholder(v)) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError('must be a number', name);
  return Math.min(max, Math.max(min, n));
}
function list(v: string | undefined, def: string[]): string[] {
  if (isPlaceholder(v)) return def;
  return v!.split(',').map((s) => s.trim()).filter(Boolean);
}

export class ConfigError extends Error {
  constructor(message: string, readonly variable: string) {
    super(`${variable}: ${message}`);
  }
}

export function normalizeOrigin(o: string): string {
  // Accept bare hostnames ("app.example.com") as https origins.
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(o) ? o : `https://${o}`);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`origin must be http(s): ${o}`);
  return u.origin;
}

/** Format: `https://app.example.com|https://auth.example.com,https://other.test` */
export function parseTargets(v: string | undefined): AuthorizedTarget[] {
  if (isPlaceholder(v)) return [];
  return v!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [origin, ...auth] = entry.split('|').map((s) => s.trim()).filter(Boolean);
      if (!origin) throw new ConfigError('empty target entry', 'RBA_AUTHORIZED_TARGETS');
      try {
        return { origin: normalizeOrigin(origin), authOrigins: auth.map(normalizeOrigin) };
      } catch (e) {
        throw new ConfigError((e as Error).message, 'RBA_AUTHORIZED_TARGETS');
      }
    });
}

function parseCountry(v: string | undefined): string | null {
  const s = str(v);
  if (!s) return null;
  if (!/^[A-Za-z]{2}$/.test(s)) throw new ConfigError('must be a 2-letter country code', 'RBA_PROXY_COUNTRY');
  return s.toUpperCase();
}

/** Apify requires run memory to be a power of two (MB). */
function powerOfTwo(n: number): number {
  if (!Number.isInteger(Math.log2(n))) throw new ConfigError('must be a power of two (512, 1024, 2048, 4096, 8192)', 'RBA_WORKER_MEMORY_MB');
  return n;
}

function parseKey(v: string | undefined): Buffer | null {
  const s = str(v);
  if (!s) return null;
  const buf = Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new ConfigError('must be 32 bytes, base64 encoded', 'RBA_ENCRYPTION_KEY');
  return buf;
}

/** True when `dir` holds a non-empty registry database (an existing install's data). */
export function hasRegistry(dir: string): boolean {
  try {
    return statSync(join(dir, 'registry.sqlite')).size > 0;
  } catch {
    return false;
  }
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Data directory. The data (encrypted with the key in the .env) always lives next
 * to the .env it belongs to, so the key and the data never drift apart:
 *  1. RBA_DATA_DIR (relative paths resolve against the .env's folder);
 *  2. <folder of the .env in use>/data — existing installs: <repo>/data, unchanged;
 *  3. no .env at all: $CLAUDE_PLUGIN_DATA/data, else <plugin root>/data.
 * Refusal: when RBA_ENV_FILE is not set and more than one .env candidate exists, and
 * a candidate other than the chosen one has a registry next to it, picking one
 * silently could hide existing accounts, so loading fails naming both paths.
 */
export function resolveDataDir(raw: string | null, file: string | null, env: NodeJS.ProcessEnv): string {
  if (raw) return isAbsolute(raw) ? raw : resolve(file ? dirname(file) : PROJECT_ROOT, raw);
  if (!file) return env.CLAUDE_PLUGIN_DATA ? join(env.CLAUDE_PLUGIN_DATA, 'data') : join(PROJECT_ROOT, 'data');
  const chosen = join(dirname(file), 'data');
  if (!env.RBA_ENV_FILE) {
    const seen = new Set([canonical(file)]);
    for (const c of envFileCandidates(env)) {
      if (!existsSync(c) || seen.has(canonical(c))) continue;
      seen.add(canonical(c));
      const other = join(dirname(c), 'data');
      if (!hasRegistry(other)) continue;
      throw new ConfigError(
        hasRegistry(chosen)
          ? `two installs with data found: ${file} (data ${chosen}) and ${c} (data ${other}). Refusing to pick one; set RBA_ENV_FILE to the .env you want, or rename the other .env.`
          : `${file} has no data yet, but existing data is next to ${c} (${other}). Refusing to start with empty data; set RBA_ENV_FILE=${c} to keep using it, or copy it with migrate-data.`,
        'RBA_DATA_DIR',
      );
    }
  }
  return chosen;
}

export const DEFAULT_DISPLAY_NAME = 'Remote Browser Accounts';

function parseDisplayName(v: string | undefined): string {
  const s = str(v);
  if (!s) return DEFAULT_DISPLAY_NAME;
  if (s.length > 64 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(s)) {
    throw new ConfigError('must be 1-64 printable characters', 'RBA_DISPLAY_NAME');
  }
  return s;
}

function flag(v: string | undefined, name: string): boolean {
  const s = str(v)?.toLowerCase();
  if (s === undefined || s === 'false' || s === '0') return false;
  if (s === 'true' || s === '1') return true;
  throw new ConfigError('must be true or false', name);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { vars: e, file } = readEnv(env);
  const dataDir = resolveDataDir(str(e.RBA_DATA_DIR), file, env);
  const mode = (str(e.RBA_DEFAULT_PROXY_MODE) ?? 'direct') as ProxyMode;
  if (!['direct', 'datacenter', 'residential'].includes(mode)) {
    throw new ConfigError('must be direct|datacenter|residential', 'RBA_DEFAULT_PROXY_MODE');
  }
  const execMode = str(e.RBA_DEFAULT_EXECUTION_MODE);
  if (execMode && !(EXECUTION_MODES as readonly string[]).includes(execMode)) {
    throw new ConfigError('must be local|remote_direct|remote_proxy', 'RBA_DEFAULT_EXECUTION_MODE');
  }
  if (execMode === 'remote_proxy' && mode === 'direct') {
    throw new ConfigError('remote_proxy needs RBA_DEFAULT_PROXY_MODE=datacenter or residential', 'RBA_DEFAULT_EXECUTION_MODE');
  }
  const allowedOrigins = list(e.RBA_ALLOWED_ORIGINS, []).map((o) => (o === '*' ? o : normalizeOrigin(o)));
  const subresourceOrigins = list(e.RBA_SUBRESOURCE_ORIGINS, []).map((o) => {
    if (o === '*') return o;
    const w = /^(https?):\/\/\*\.([a-z0-9.-]+)(:\d+)?$/i.exec(o);
    if (w) return `${w[1]!.toLowerCase()}://*.${w[2]!.toLowerCase()}${w[3] ?? ''}`;
    try {
      return normalizeOrigin(o);
    } catch (err) {
      throw new ConfigError((err as Error).message, 'RBA_SUBRESOURCE_ORIGINS');
    }
  });
  return {
    envFile: file,
    dataDir,
    apify: {
      token: str(e.APIFY_TOKEN),
      actorId: str(e.APIFY_ACTOR_ID),
      build: str(e.APIFY_ACTOR_BUILD),
      apiBaseUrl: (str(e.APIFY_API_BASE_URL) ?? 'https://api.apify.com').replace(/\/+$/, ''),
      workerMemoryMb: powerOfTwo(num(e.RBA_WORKER_MEMORY_MB, 2048, 512, 8192, 'RBA_WORKER_MEMORY_MB')),
      cuPriceUsd: num(e.RBA_APIFY_CU_PRICE_USD, 0.2, 0, 10, 'RBA_APIFY_CU_PRICE_USD'),
      residentialGbPriceUsd: num(e.RBA_RESIDENTIAL_GB_PRICE_USD, 8, 0, 100, 'RBA_RESIDENTIAL_GB_PRICE_USD'),
      residentialReserveGb: num(e.RBA_RESIDENTIAL_RESERVE_GB, 0.02, 0.001, 100, 'RBA_RESIDENTIAL_RESERVE_GB'),
    },
    mailslurp: {
      apiKey: str(e.MAILSLURP_API_KEY),
      apiBaseUrl: (str(e.MAILSLURP_API_BASE_URL) ?? 'https://api.mailslurp.com').replace(/\/+$/, ''),
      inboxExpiresHours: num(e.RBA_INBOX_EXPIRES_HOURS, 0, 0, 24 * 365, 'RBA_INBOX_EXPIRES_HOURS'),
      useDomainPool: str(e.RBA_MAILSLURP_USE_DOMAIN_POOL) === 'true',
      maxInboxesPerMonth: num(e.RBA_MAILSLURP_MAX_INBOXES_PER_MONTH, 90, 0, 100000, 'RBA_MAILSLURP_MAX_INBOXES_PER_MONTH'),
      maxEmailsPerMonth: num(e.RBA_MAILSLURP_MAX_EMAILS_PER_MONTH, 450, 0, 1000000, 'RBA_MAILSLURP_MAX_EMAILS_PER_MONTH'),
    },
    encryptionKey: parseKey(e.RBA_ENCRYPTION_KEY),
    targets: parseTargets(e.RBA_AUTHORIZED_TARGETS),
    allowedOrigins,
    subresourceOrigins,
    allowPrivateHosts: list(e.RBA_ALLOW_PRIVATE_HOSTS, []),
    localRecordVideoDir: str(e.RBA_LOCAL_RECORD_VIDEO_DIR) ? resolve(str(e.RBA_LOCAL_RECORD_VIDEO_DIR)!) : null,
    proxy: { defaultMode: mode, country: parseCountry(e.RBA_PROXY_COUNTRY) },
    defaultExecutionMode: (execMode as ExecutionMode | null) ?? null,
    egressCheckUrl: str(e.RBA_EGRESS_CHECK_URL) ?? 'https://api.apify.com/v2/browser-info',
    limits: {
      monthlyBudgetUsd: num(e.RBA_MONTHLY_BUDGET_USD, 1, 0, 100000, 'RBA_MONTHLY_BUDGET_USD'),
      maxConcurrentSessions: num(e.RBA_MAX_CONCURRENT_SESSIONS, 1, 1, 50, 'RBA_MAX_CONCURRENT_SESSIONS'),
      maxSessionMinutes: num(e.RBA_MAX_SESSION_MINUTES, 10, 1, 24 * 60, 'RBA_MAX_SESSION_MINUTES'),
      idleTimeoutSecs: num(e.RBA_IDLE_TIMEOUT_SECS, 180, 30, 3600, 'RBA_IDLE_TIMEOUT_SECS'),
      maxCrawlPages: num(e.RBA_MAX_CRAWL_PAGES, 50, 1, 1000, 'RBA_MAX_CRAWL_PAGES'),
      maxCrawlDepth: num(e.RBA_MAX_CRAWL_DEPTH, 3, 0, 10, 'RBA_MAX_CRAWL_DEPTH'),
      maxRetries: num(e.RBA_MAX_RETRIES, 2, 0, 3, 'RBA_MAX_RETRIES'),
      emailWaitMaxSecs: num(e.RBA_EMAIL_WAIT_MAX_SECS, 600, 5, 3600, 'RBA_EMAIL_WAIT_MAX_SECS'),
      maxUploadBytes: num(e.RBA_MAX_UPLOAD_MB, 10, 0.001, 50, 'RBA_MAX_UPLOAD_MB') * 1024 * 1024,
      leaseTtlSecs: num(e.RBA_LEASE_TTL_SECS, 120, 10, 3600, 'RBA_LEASE_TTL_SECS'),
    },
    uploadRoots: list(e.RBA_UPLOAD_ROOTS, []).map((p) => resolve(p)),
    files: {
      importRoots: list(e.RBA_IMPORT_ROOTS, []).map((p) => resolve(p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))),
      maxImportBytes: num(e.RBA_MAX_IMPORT_MB, 200, 0.001, 2048, 'RBA_MAX_IMPORT_MB') * 1024 * 1024,
      maxImagePixels: num(e.RBA_MAX_IMAGE_MEGAPIXELS, 100, 1, 1000, 'RBA_MAX_IMAGE_MEGAPIXELS') * 1_000_000,
      toolTimeoutMs: num(e.RBA_MEDIA_TOOL_TIMEOUT_SECS, 300, 5, 3600, 'RBA_MEDIA_TOOL_TIMEOUT_SECS') * 1000,
    },
    retention: {
      logDays: num(e.RBA_LOG_RETENTION_DAYS, 30, 0, 3650, 'RBA_LOG_RETENTION_DAYS'),
      artifactDays: num(e.RBA_ARTIFACT_RETENTION_DAYS, 14, 0, 3650, 'RBA_ARTIFACT_RETENTION_DAYS'),
    },
    displayName: parseDisplayName(e.RBA_DISPLAY_NAME),
    dashboard: { port: num(e.RBA_DASHBOARD_PORT, 4777, 1024, 65535, 'RBA_DASHBOARD_PORT'), token: str(e.RBA_DASHBOARD_TOKEN) },
    operations: { enabled: flag(e.RBA_OPERATIONS_ENABLED, 'RBA_OPERATIONS_ENABLED') },
  };
}

/** Names (never values) of variables missing for each capability. */
export function missingByCapability(c: Config): Record<string, string[]> {
  const m: Record<string, string[]> = { browser: [], browse_without_account: [], email: [], storage: [], signup: [], dashboard: [] };
  if (!c.apify.token) m.browser!.push('APIFY_TOKEN');
  if (!c.apify.actorId) m.browser!.push('APIFY_ACTOR_ID');
  if (!c.mailslurp.apiKey) m.email!.push('MAILSLURP_API_KEY');
  if (!c.encryptionKey) m.storage!.push('RBA_ENCRYPTION_KEY');
  if (c.targets.length === 0) m.signup!.push('RBA_AUTHORIZED_TARGETS');
  if (c.allowedOrigins.length === 0) m.browse_without_account!.push('RBA_ALLOWED_ORIGINS');
  if (!c.dashboard.token) m.dashboard!.push('RBA_DASHBOARD_TOKEN');
  return m;
}
