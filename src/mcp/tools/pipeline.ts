/**
 * Pipeline help: what this installation can do right now, which execution
 * modes are available, and which tools make up each pipeline stage. Read-only;
 * starts nothing and contacts no provider (lead-owned, INTERFACES.md §5).
 */
import { missingByCapability } from '../../core/config.js';
import type { Ctx } from '../../core/context.js';
import { describeMode, EXECUTION_MODES, type ExecutionMode } from '../../core/modes.js';
import { which } from '../../files/exec.js';
import { LocalProvider } from '../../providers/local.js';
import type { ToolDef } from './types.js';

export const PIPELINE_COMMAND = '/remote-browser-accounts:pipeline';

interface StageInfo {
  stage: string;
  use_when: string;
  skip_when: string;
  tools: string[];
  available: boolean;
  unavailable_reason?: string;
}

function modeAvailability(ctx: Ctx): Record<ExecutionMode, { available: boolean; reason: string | null; meaning: string }> {
  const remoteMissing = missingByCapability(ctx.cfg).browser ?? [];
  const remote = remoteMissing.length ? `remote provider not configured (missing ${remoteMissing.join(', ')})` : !ctx.providers.remote ? 'remote provider not configured' : null;
  const localReason = !ctx.providers.local ? 'disabled in this installation' : ctx.providers.local instanceof LocalProvider ? ctx.providers.local.unavailableReason() : null;
  const storage = ctx.vault.available ? null : 'RBA_ENCRYPTION_KEY missing (sessions need encrypted token storage)';
  const out = {} as Record<ExecutionMode, { available: boolean; reason: string | null; meaning: string }>;
  for (const m of EXECUTION_MODES) {
    const reason = storage ?? (m === 'local' ? localReason : remote);
    out[m] = { available: !reason, reason, meaning: describeMode(m) };
  }
  return out;
}

export function capabilitiesReport(ctx: Ctx): Record<string, unknown> {
  const modes = modeAvailability(ctx);
  const anyBrowser = Object.values(modes).some((m) => m.available);
  const missing = missingByCapability(ctx.cfg);
  const mediaTools = ['ffmpeg', 'ffprobe', 'pdfinfo'].filter((t) => !which(t));
  const operationsEnabled = ctx.cfg.operations.enabled;
  const stages: StageInfo[] = [
    {
      stage: 'browse_extract',
      use_when: 'read or extract public or logged-in page content',
      skip_when: 'a reviewed saved operation already answers the question',
      tools: ['session_start', 'browser_navigate', 'browser_inspect', 'scrape_extract', 'session_close'],
      available: anyBrowser,
      unavailable_reason: anyBrowser ? undefined : 'no execution mode is available',
    },
    {
      stage: 'crawl',
      use_when: 'the same extraction over many pages (bounded by RBA_MAX_CRAWL_PAGES / depth)',
      skip_when: 'one or a few pages',
      tools: ['crawl_start', 'job_status', 'job_results'],
      available: anyBrowser,
    },
    {
      stage: 'saved_operations',
      use_when: 'repeat READ requests against a site; learn only when the user asks or the same read will clearly repeat',
      skip_when: 'one-off extraction, any write/submit/payment, or the user did not ask to learn',
      tools: ['operation_list', 'operation_call', 'operation_validate', 'operation_learn', 'operation_review', 'operation_delete'],
      available: operationsEnabled,
      unavailable_reason: operationsEnabled ? undefined : 'RBA_OPERATIONS_ENABLED is off (optional feature)',
    },
    {
      stage: 'account',
      use_when: 'the task needs a login: reuse an existing account (account_list) before creating one',
      skip_when: 'public pages. Never create an inbox or account for public extraction',
      tools: ['account_list', 'account_add', 'account_register', 'session_save_state'],
      available: anyBrowser,
    },
    {
      stage: 'email',
      use_when: 'a signup or login sends a verification email to an account inbox',
      skip_when: 'no account is involved',
      tools: ['email_wait_for_verification', 'email_search'],
      available: missing.email!.length === 0,
      unavailable_reason: missing.email!.length ? `missing ${missing.email!.join(', ')}` : undefined,
    },
    {
      stage: 'files',
      use_when: 'the user supplied a file to inspect, clean or upload (local only; no browser is started)',
      skip_when: 'no file is involved',
      tools: ['file_import', 'media_inspect', 'media_sanitize', 'media_verify', 'file_delete'],
      available: true,
      unavailable_reason: mediaTools.length ? `some formats need missing local tools: ${mediaTools.join(', ')} (npm run doctor)` : undefined,
    },
    {
      stage: 'upload',
      use_when: 'the user asked to upload a file to a named portal; observe a portal confirmation',
      skip_when: 'the user did not ask to upload',
      tools: ['portal_upload'],
      available: anyBrowser,
    },
    {
      stage: 'report_cleanup',
      use_when: 'always at the end: close sessions, check jobs, report cost and what remains uncertain',
      skip_when: 'never',
      tools: ['session_status', 'job_status', 'usage_report', 'run_report'],
      available: true,
    },
  ];
  return {
    command: PIPELINE_COMMAND,
    routing_note: `Natural-language routing to the pipeline is best effort. ${PIPELINE_COMMAND} <task> is the reliable entry point.`,
    executionModes: modes,
    defaultMode: ctx.cfg.defaultExecutionMode ?? (ctx.cfg.proxy.defaultMode === 'direct' ? 'remote_direct' : 'remote_proxy'),
    modeRules: [
      'A mode that cannot be honoured is refused; there is no fallback between modes.',
      'An account is bound to the mode it was created in; using it in another mode is refused.',
      'local uses a fresh temporary automation profile and never discovers, reads or imports your personal browser profile or cookies.',
      'No mode is anonymous. remote_proxy "verified" means the browser egress IP differed from the worker IP at session start.',
    ],
    stages,
    authorizedSignupTargets: ctx.cfg.targets.map((t) => t.origin),
    navigationWithoutAccount: ctx.cfg.allowedOrigins,
    limits: {
      monthlyBudgetUsd: ctx.cfg.limits.monthlyBudgetUsd,
      maxConcurrentSessions: ctx.cfg.limits.maxConcurrentSessions,
      maxSessionMinutes: ctx.cfg.limits.maxSessionMinutes,
    },
    missingConfiguration: missing,
  };
}

export const PIPELINE_TOOLS: ToolDef[] = [
  {
    name: 'pipeline_capabilities',
    description: `Read-only help for the web-task pipeline: available execution modes (local | remote_direct | remote_proxy) and why one is unavailable, the pipeline stages with the tools for each and when to skip them, authorised targets, budget limits and missing configuration NAMES. Starts nothing and incurs no cost. Call it first when planning a web task; the explicit entry point is ${PIPELINE_COMMAND}.`,
    shape: {},
    handler: async (ctx) => ({ data: capabilitiesReport(ctx) }),
  },
];
