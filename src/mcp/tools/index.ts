/** Tool registry: every MCP tool, aggregated from per-area modules (docs/dev/INTERFACES.md §5). */
import { CORE_TOOLS } from './core.js';
import { FILE_TOOLS } from './files.js';
import { OPERATION_TOOLS } from './operations.js';
import { PIPELINE_TOOLS } from './pipeline.js';
import { REPORT_TOOLS } from './reports.js';
import type { ToolDef } from './types.js';

export type { ToolDef, ToolResult } from './types.js';
export { recoverJobs } from './core.js';

export const TOOLS: ToolDef[] = [...CORE_TOOLS, ...FILE_TOOLS, ...OPERATION_TOOLS, ...REPORT_TOOLS, ...PIPELINE_TOOLS];

const seen = new Set<string>();
for (const t of TOOLS) {
  if (seen.has(t.name)) throw new Error(`duplicate tool name ${t.name}`);
  seen.add(t.name);
}
