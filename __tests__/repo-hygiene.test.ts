import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * This repository is public, so nothing in it may locate the operator's
 * infrastructure: no host addresses, subnets, machine names or home paths
 * (issue #329). The details live in the operator's local runbook instead.
 *
 * Strategy: scan every tracked text file with `git grep`, then filter matches in
 * JS against an allowlist of values that identify no one — special-purpose IPv4
 * ranges, placeholder home directories. The test deliberately never names the
 * values it guards against; spelling them out here would re-publish them.
 */

const ROOT = path.resolve(__dirname, '..');

/** `git grep` over tracked, non-binary files. Returns `file:line:match` rows. */
function gitGrep(pattern: string): string[] {
  try {
    return execFileSync('git', ['grep', '-nIoE', pattern], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

/** Addresses that are not anybody's machine: RFC 1918/5737/6890 ranges plus public resolvers. */
function isNonIdentifyingIPv4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true; // this-net, private, loopback, multicast/reserved
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  return ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'].includes(ip);
}

/**
 * Failures report `file:line` only. CI logs are public, so echoing the matched
 * value would publish it a second time.
 */
const location = (row: string): string => row.split(':', 2).join(':');

describe('repo hygiene: no operator infrastructure in tracked files (#329)', () => {
  it('contains no IPv4 address or CIDR outside documentation/special-purpose ranges', () => {
    const offenders = gitGrep('\\b([0-9]{1,3}\\.){3}[0-9]{1,3}(/[0-9]{1,2})?\\b').filter((row) => {
      const ip = row.slice(row.lastIndexOf(':') + 1).split('/')[0];
      return !isNonIdentifyingIPv4(ip);
    });
    expect(offenders.map(location)).toEqual([]);
  });

  it('contains no real home directory path', () => {
    const placeholders = new Set(['you', 'user', 'test', 'u', 'runner', 'node', 'pwuser']);
    const offenders = gitGrep('/(home|Users)/[A-Za-z0-9._-]+').filter((row) => {
      const name = row.slice(row.lastIndexOf('/') + 1);
      return !placeholders.has(name);
    });
    expect(offenders.map(location)).toEqual([]);
  });

  it('names no machine after the repo owner (the operator host naming scheme)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const owner = /github\.com\/([^/]+)\//.exec(pkg.repository.url)?.[1];
    expect(owner).toBeTruthy();
    expect(gitGrep(`\\b${owner}-[A-Za-z0-9]`).map(location)).toEqual([]);
  });

  describe('deploy diagnostics in public Actions logs', () => {
    const workflowDir = path.join(ROOT, '.github', 'workflows');
    const commands = fs
      .readdirSync(workflowDir)
      .filter((f) => /\.ya?ml$/.test(f))
      .flatMap((f) =>
        fs
          .readFileSync(path.join(workflowDir, f), 'utf8')
          .split('\n')
          .map((line, i) => ({ where: `${f}:${i + 1}`, line: line.trim() })),
      )
      .filter(({ line }) => !line.startsWith('#'));

    // `tailscale status` lists every peer's name and address; BackendState is
    // the only field the workflow needs, and it identifies nothing.
    it('reads tailscale status only as its BackendState', () => {
      const offenders = commands.filter(
        ({ line }) =>
          /tailscale status\b/.test(line) &&
          !/tailscale status --json[^|]*\| *jq -r '\.BackendState/.test(line),
      );
      expect(offenders.map(({ where }) => where)).toEqual([]);
    });

    // `tailscale ping` prints the peer's addresses and its public endpoint.
    // Its output may be captured and classified, never streamed to the log.
    it('captures tailscale ping output instead of printing it', () => {
      const offenders = commands.filter(
        ({ line }) =>
          /tailscale ping +[-"$\w]/.test(line) && !/=\$\([^)]*tailscale ping/.test(line),
      );
      expect(offenders.map(({ where }) => where)).toEqual([]);
    });
  });
});
