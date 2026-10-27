import { z } from 'zod';
import type { ToolDef } from './types.js';

/** Per-run execution reports (W3 owns; see docs/dev/INTERFACES.md §6). */
export const REPORT_TOOLS: ToolDef[] = [
  {
    name: 'run_report',
    description:
      'Execution report of one browser run, by runId, jobId or sessionId: requested and effective execution mode; route (proxy, verification and its limits); account reference (id and origin only); files sent with their SHA-256 and sanitization status (policy version, findings, gaps, accepted digest, file name sent); confirmation evidence (a description of what matched, never page text); pending and finished cleanup; estimated vs provider-reported cost; and what is uncertain. Returns the snapshot taken when the run finished (cost and cleanup refreshed) or, before that, a report derived from stored state.',
    shape: {
      runId: z.string().max(200).optional(),
      jobId: z.string().max(200).optional(),
      sessionId: z.string().max(200).optional(),
    },
    handler: async (ctx, a) => ({ data: await ctx.reports.get({ runId: a.runId, jobId: a.jobId, sessionId: a.sessionId }) }),
  },
];
