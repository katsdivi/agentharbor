import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx } from '../core/context.js';
import { asRbaError } from '../core/errors.js';
import { redact, redactDeep } from '../core/redact.js';
import { versions } from '../core/version.js';
import { TOOLS } from './tools/index.js';

/** MCP server version: release version + build commit (see src/core/version.ts). */
export const SERVER_VERSION = versions().mcpServer;

/** Every response passes through redaction; errors become isError results, never thrown. */
export function createServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: 'remote-browser-accounts', title: ctx.cfg.displayName, version: SERVER_VERSION });
  for (const t of TOOLS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.shape, ...(t.title ? { title: t.title } : {}), ...(t.annotations ? { annotations: { ...(t.title ? { title: t.title } : {}), ...t.annotations } } : {}) }, (async (args: unknown) => {
      try {
        const r = await t.handler(ctx, args ?? {});
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text', text: JSON.stringify(redactDeep(r.data), null, 2) },
        ];
        if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
        return { content };
      } catch (e) {
        const err = asRbaError(e);
        ctx.db.log('warn', `tool ${t.name} failed: ${err.code} ${err.message}`);
        return {
          isError: true,
          content: [{ type: 'text', text: redact(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details ? redactDeep(err.details) : undefined } }, null, 2)) }],
        };
      }
    }) as never);
  }
  return server;
}
