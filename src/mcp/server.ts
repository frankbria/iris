#!/usr/bin/env node
/**
 * IRIS MCP server (experimental, plan 012).
 *
 * Speaks the Model Context Protocol over stdio so assistants such as Claude Code
 * can drive IRIS directly. Spike scope is deliberately one tool — see
 * `./tools.ts`.
 *
 * stdout is the JSON-RPC transport. Nothing in this process may print to it;
 * all diagnostics go to stderr, or the client's stream is corrupted.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools';

/**
 * Read the package version at runtime rather than hardcoding it, so the value
 * an MCP client sees cannot drift from the published package. `__dirname` is
 * `<pkg>/dist/mcp` in both a local build and an installed dependency.
 */
function packageVersion(): string {
  const manifest = readFileSync(path.join(__dirname, '../../package.json'), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

export async function main(): Promise<void> {
  const server = new McpServer({ name: 'iris', version: packageVersion() });
  registerTools(server);
  await server.connect(new StdioServerTransport());

  // Exit on SIGTERM / SIGINT and when the client closes stdin (#309). The SDK neither
  // handles a signal nor ends on EOF, so a scan in progress kept the process (and its
  // Chromium) running after the client was gone. Playwright closes the browsers it
  // launched when the process exits.
  let exiting = false;
  const exit = (reason: string) => {
    if (exiting) return;
    exiting = true;
    console.error(`[iris-mcp] ${reason}; exiting`);
    void server.close().finally(() => process.exit(0));
    // A close that hangs (a tool call holding the transport) must not keep the process.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => exit('SIGTERM'));
  process.on('SIGINT', () => exit('SIGINT'));
  process.stdin.on('end', () => exit('stdin closed'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[iris-mcp] failed to start:', error);
    process.exit(1);
  });
}
