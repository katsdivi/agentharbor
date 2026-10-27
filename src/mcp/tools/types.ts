import type { z } from 'zod';
import type { Ctx } from '../../core/context.js';

export interface ToolResult {
  data: unknown;
  image?: { data: string; mimeType: string };
}

/** MCP tool annotations (hints to the client; see the MCP spec's ToolAnnotations). */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  /** Human-readable title shown by clients. */
  title?: string;
  annotations?: ToolAnnotations;
  description: string;
  shape: z.ZodRawShape;
  handler: (ctx: Ctx, args: any) => Promise<ToolResult>;
}
