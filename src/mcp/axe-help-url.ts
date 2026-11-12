import { readFileSync } from 'fs';
import { z } from 'zod';

/**
 * `major.minor` of the installed axe-core, which is how Deque versions its rule pages.
 * Read from the manifest: importing axe itself would load the whole engine into the API
 * process, which never scans.
 */
function axeDocsVersion(): string {
  const manifest = readFileSync(require.resolve('axe-core/package.json'), 'utf8');
  const { version } = z.object({ version: z.string() }).parse(JSON.parse(manifest));
  return version.slice(0, version.lastIndexOf('.'));
}

let docsVersion: string | undefined;

/**
 * Deque's documentation page for an axe rule, as axe itself links it (#648). Built from
 * the rule id rather than stored with a scan: axe runs inside the page under test, so the
 * `helpUrl` it returns is text that page can choose, and this one always points at Deque.
 * The version is the installed one, which may be newer than the one that scanned.
 */
export function axeRuleHelpUrl(ruleId: string): string {
  docsVersion ??= axeDocsVersion();
  return `https://dequeuniversity.com/rules/axe/${docsVersion}/${encodeURIComponent(ruleId)}?application=axeAPI`;
}
