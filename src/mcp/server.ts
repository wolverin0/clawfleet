#!/usr/bin/env node
/**
 * theorchestra v3.0 MCP server — exposes 16 tools (v2.7 parity) over stdio.
 *
 * Each tool is implemented in `src/mcp/handlers/*` and registered here. The
 * backend HTTP endpoints on :4300 are the actual execution surface; this file
 * is just glue that binds MCP-SDK tool registrations to those handlers.
 *
 * Logging rule: stdio is the MCP protocol stream, so ALL log output MUST go to
 * stderr. `console.error` is the portable way.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { ToolHandler } from './handler-types.js';
import { sessionMgmtHandlers } from './handlers/session-mgmt.js';
import { ioHandlers } from './handlers/io.js';
import { layoutHandlers } from './handlers/layout.js';
import { highLevelHandlers } from './handlers/high-level.js';
import { omniclaudeHandlers } from './handlers/omniclaude.js';

const VERSION = '3.0.0-alpha.1';

function log(...args: unknown[]): void {
  process.stderr.write(`[theorchestra-mcp] ${args.map(String).join(' ')}\n`);
}

function register(server: McpServer, handler: ToolHandler<unknown>): void {
  // SDK's callback signature is structural and stricter than our ToolResult,
  // so we widen via `as` at the boundary. The SDK does the actual validation
  // of the returned shape against its CallToolResult schema at runtime.
  const callback = (async (input: unknown) => {
    try {
      return await handler.run(input as never);
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      log(`tool ${handler.name} threw:`, msg);
      return {
        content: [{ type: 'text' as const, text: `Internal error in ${handler.name}: ${msg}` }],
        isError: true,
      };
    }
  }) as Parameters<typeof server.registerTool>[2];

  server.registerTool(
    handler.name,
    {
      description: handler.description,
      inputSchema: handler.inputSchema,
    },
    callback,
  );
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'theorchestra', version: VERSION });

  const allHandlers: ToolHandler<unknown>[] = [
    ...sessionMgmtHandlers,
    ...ioHandlers,
    ...layoutHandlers,
    ...highLevelHandlers,
    ...omniclaudeHandlers,
  ];

  for (const h of allHandlers) register(server, h);

  log(`registering ${allHandlers.length} tool(s):`, allHandlers.map((h) => h.name).join(', '));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log('theorchestra v3.0 MCP server ready on stdio');
}

main().catch((err) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  log('fatal:', msg);
  process.exit(1);
});
