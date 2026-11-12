import { readFileSync } from 'fs';
import * as path from 'path';

/**
 * Read the package version at runtime rather than hardcoding it, so the value
 * an MCP client sees cannot drift from the published package. `__dirname` is
 * `<pkg>/dist/mcp` in both a local build and an installed dependency.
 */
export function packageVersion(): string {
  const manifest = readFileSync(path.join(__dirname, '../../package.json'), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}
