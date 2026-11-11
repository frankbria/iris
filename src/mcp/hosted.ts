/**
 * Hosted MCP (#314): `POST /v1/mcp` on the `iris connect` listener, MCP Streamable HTTP
 * behind the org API key.
 *
 * A tool call here does not drive a browser. It queues the same a11y job `POST
 * /v1/a11y/jobs` does, so the worker scans the page (hardened Chromium, egress proxy, job
 * deadline) and records the run in the org's history and usage; this module only waits
 * for the outcome and words it for a model. What it may say is bounded as the stdio
 * tool's is (#362): a failure carries a reason from the fixed vocabulary, never the stored
 * error text.
 *
 * Stateless: every request gets its own server and transport and one JSON response. No
 * session id, no SSE stream, so nothing outlives a request and any replica can answer.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RunQuotaExceededError, type StoredJob, type TenantScope } from '../history-store';
import { authorize, readBody, send, type ApiJobs, type JobsApiDeps } from '../jobs-api';
import { errMessage, log } from '../log';
import { assertNavigationAllowed } from '../url-policy';
import { JOB_TIMED_OUT, ORG_SUSPENDED } from '../worker';
import { scanFailureReason } from './scan-errors';
import { packageVersion } from './version';

export const MCP_PATH = '/v1/mcp';
export const RUN_ACCESSIBILITY_TEST = 'run_accessibility_test';
export const GET_ACCESSIBILITY_TEST_RESULT = 'get_accessibility_test_result';

/** Same bound as the job API's `urls` entries. */
const MAX_URL_LENGTH = 2048;

/** Every impact fails the run, so `passed` means what the stdio tool's does: no violation. */
const FAIL_ON_ANY = ['critical', 'serious', 'moderate', 'minor'] as const;

const outputSchema = {
  jobId: z.string().describe(`The scan's id: pass it to ${GET_ACCESSIBILITY_TEST_RESULT}.`),
  status: z
    .enum(['queued', 'running', 'finished'])
    .describe('Only a finished scan carries the fields below.'),
  url: z.string().optional().describe('The page that was requested.'),
  passed: z
    .boolean()
    .optional()
    .describe('True when axe-core reported no violations and the keyboard checks passed.'),
  violationCount: z.number().optional().describe('Total number of distinct axe rules violated.'),
  violations: z
    .array(
      z.object({
        id: z.string().describe('axe rule id, e.g. "image-alt".'),
        impact: z.enum(['minor', 'moderate', 'serious', 'critical']).nullable(),
        nodes: z.number().describe('How many elements on the page violate this rule.'),
      }),
    )
    .optional()
    .describe('One entry per violated axe rule, at most 50. Empty when there are none.'),
  needsReviewRules: z
    .array(z.string())
    .optional()
    .describe(
      'Ids of rules axe could not decide automatically: a person must check them. They do ' +
        'not fail the scan.',
    ),
  keyboardPassed: z.boolean().optional().describe('Whether the keyboard checks passed.'),
};

type ToolOutput = z.infer<z.ZodObject<typeof outputSchema>>;

/** One page of a stored a11y run, as `history-store` writes it; older rows lack the rules. */
const StoredPage = z.object({
  url: z.string().nullable(),
  passed: z.boolean(),
  result: z.object({
    error: z.string().optional(),
    violations: z.record(z.string(), z.number()).default({}),
    violationRules: outputSchema.violations.unwrap().default([]),
    needsReviewRules: z.array(z.string()).default([]),
    keyboardPassed: z.boolean().default(true),
  }),
});

function toolError(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function toolResult(text: string, structuredContent: ToolOutput) {
  return { content: [{ type: 'text' as const, text }], structuredContent };
}

/**
 * Why `url` cannot be queued, or `null`. Refused here rather than by the worker, so a URL
 * that could never be scanned costs the org no run.
 */
function urlRefusal(url: string): string | null {
  const target = URL.parse(url);
  if (!target || !/^https?:$/.test(target.protocol)) return 'The URL must be an http(s) URL.';
  // Job params are stored and readable by the whole org.
  if (target.username || target.password) return 'The URL must not contain credentials.';
  try {
    assertNavigationAllowed(url);
  } catch (error) {
    return errMessage(error).split('\n')[0];
  }
  return null;
}

/** The worker's own fixed messages may be repeated; anything else is page-influenced text. */
function jobFailureReason(error: string): string {
  if (error === ORG_SUSPENDED) return 'the organization is suspended';
  if (error === JOB_TIMED_OUT) return 'the scan did not finish in time';
  return scanFailureReason(error);
}

/** A job as a tool result: still under way, failed to run, or its one page's findings. */
function describeJob(job: StoredJob) {
  if (job.status === 'queued' || job.status === 'running') {
    return toolResult(
      `The scan is ${job.status}. Call ${GET_ACCESSIBILITY_TEST_RESULT} with jobId ` +
        `"${job.id}" for its result.`,
      { jobId: job.id, status: job.status },
    );
  }
  if (job.error !== null) {
    log('warn', 'mcp scan failed', { jobId: job.id, detail: job.error });
    return toolError(`Accessibility scan ${job.id} failed: ${jobFailureReason(job.error)}.`);
  }
  if (job.results.length !== 1) {
    return toolError(
      `Scan ${job.id} covered ${job.results.length} pages; read it at GET /v1/jobs/${job.id}.`,
    );
  }
  const page = StoredPage.parse(job.results[0]);
  if (page.result.error !== undefined) {
    log('warn', 'mcp scan failed', { jobId: job.id, detail: page.result.error });
    return toolError(
      `Accessibility scan ${job.id} failed: ${scanFailureReason(page.result.error)}.`,
    );
  }
  const violationCount = Object.values(page.result.violations).reduce((sum, n) => sum + n, 0);
  const violations = page.result.violationRules;
  const url = page.url ?? 'the requested URL';
  const lines = [
    violationCount === 0
      ? `No WCAG violations found on ${url}.`
      : `${violationCount} WCAG violation(s) on ${url}:`,
    ...violations.map((v) => `- [${v.impact ?? 'unrated'}] ${v.id} (${v.nodes} element(s))`),
    ...(page.result.keyboardPassed ? [] : ['The keyboard checks failed.']),
    ...(page.result.needsReviewRules.length === 0
      ? []
      : [`Rules that need manual review: ${page.result.needsReviewRules.join(', ')}`]),
  ];
  return toolResult(lines.join('\n'), {
    jobId: job.id,
    status: 'finished',
    url,
    passed: page.passed,
    violationCount,
    violations,
    needsReviewRules: page.result.needsReviewRules,
    keyboardPassed: page.result.keyboardPassed,
  });
}

/** What the tools need of one request: the caller's org, its limits, and whether it is still there. */
export interface HostedToolsDeps {
  jobs: ApiJobs;
  /** Queued + running jobs the org may have. */
  maxOutstanding: number;
  /** The plan's runs this month (#346); unset, no monthly limit applies. */
  monthlyRunLimit?: number;
  /** How long a call waits for its scan before answering with the job id. */
  waitMs: number;
  /** Aborted when the client went away: a scan it still waits in the queue for is withdrawn. */
  gone: AbortSignal;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The job once it has finished, or as it stands when `waitMs` is over; `null` when the
 * caller went away (its job is withdrawn if no worker has taken it yet).
 */
async function awaitJob(id: string, deps: HostedToolsDeps): Promise<StoredJob | null> {
  const pollMs = Math.min(1_000, deps.waitMs / 4);
  const deadline = performance.now() + deps.waitMs;
  for (;;) {
    if (deps.gone.aborted) {
      await deps.jobs.cancel?.(id);
      return null;
    }
    const job = await deps.jobs.get(id);
    if (!job) return null;
    const pending = job.status === 'queued' || job.status === 'running';
    if (!pending || performance.now() >= deadline) return job;
    await sleep(pollMs);
  }
}

async function runScan(url: string, wcagLevel: 'AA' | 'AAA', deps: HostedToolsDeps) {
  const refusal = urlRefusal(url);
  if (refusal) return toolError(refusal);
  let id: string | null;
  try {
    id = await deps.jobs.enqueue(
      { kind: 'a11y', params: { urls: [url], wcagLevel, failOn: [...FAIL_ON_ANY] } },
      { maxOutstanding: deps.maxOutstanding, monthlyRunLimit: deps.monthlyRunLimit },
    );
  } catch (error) {
    if (!(error instanceof RunQuotaExceededError)) throw error;
    return toolError(
      `Monthly run limit reached: ${error.used} of ${error.limit} runs used. No scan was started.`,
    );
  }
  if (id === null) {
    return toolError(
      `Too many scans: this organization already has ${deps.maxOutstanding} queued or ` +
        'running. Call again when one has finished.',
    );
  }
  const job = await awaitJob(id, deps);
  // Nobody reads this: the client is gone.
  return job ? describeJob(job) : toolError('The scan was withdrawn.');
}

async function readScan(jobId: string, deps: HostedToolsDeps) {
  const job = await deps.jobs.get(jobId);
  // Another org's id reads exactly like an unknown one.
  if (!job || job.kind !== 'a11y') {
    return toolError('No accessibility scan with that id in this organization.');
  }
  return describeJob(job);
}

export function registerHostedTools(server: McpServer, deps: HostedToolsDeps): void {
  server.registerTool(
    RUN_ACCESSIBILITY_TEST,
    {
      title: 'Run accessibility test',
      description:
        'Scan a public web page with axe-core in a hosted headless browser and report WCAG ' +
        'violations, plus whether the keyboard checks passed. The URL must be reachable from ' +
        "the internet. Counts as one run on the organization's plan. Waits up to " +
        `${Math.round(deps.waitMs / 1000)} s; a scan that takes longer answers with status ` +
        `"queued" or "running" and a jobId for ${GET_ACCESSIBILITY_TEST_RESULT}. Not ` +
        'read-only: loading the page runs its scripts and sends the requests a browser visit would.',
      inputSchema: {
        url: z
          .string()
          .max(MAX_URL_LENGTH)
          .describe('Absolute http(s) URL of the page to scan, without credentials.'),
        wcagLevel: z
          .enum(['AA', 'AAA'])
          .optional()
          .describe('WCAG 2.2 conformance level to check against. Defaults to AA.'),
      },
      outputSchema,
      // As the stdio tool (#362): a real browser visits a URL the model chose.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    ({ url, wcagLevel }) => runScan(url, wcagLevel ?? 'AA', deps),
  );
  server.registerTool(
    GET_ACCESSIBILITY_TEST_RESULT,
    {
      title: 'Get accessibility test result',
      description:
        `Read a scan started by ${RUN_ACCESSIBILITY_TEST}, by its jobId: its findings once ` +
        'finished, else its status. Starts nothing and costs no run.',
      inputSchema: { jobId: z.string().max(64).describe('The jobId a scan answered with.') },
      outputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ jobId }) => readScan(jobId, deps),
  );
}

export type McpHttpDeps = Pick<
  JobsApiDeps,
  'authenticate' | 'admit' | 'charge' | 'entitlements' | 'maxQueuedJobsPerOrg'
> & {
  jobs: { forOrg(scope: TenantScope): ApiJobs };
  /** `ServerLimits.mcpScanWaitMs`. */
  waitMs: number;
};

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  send(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/** The request's JSON-RPC message, or `null` once it was refused (413, or 400 with a JSON-RPC error). */
async function readMessage(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const text = await readBody(req);
  if (text === null) {
    send(res, 413, { error: 'Request body too large' });
    return null;
  }
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    rpcError(res, 400, -32700, 'Parse error');
    return null;
  }
  // As on the WebSocket (#528): one request would start many scans for one rate token.
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    rpcError(res, 400, -32600, 'Invalid Request: batch requests are not supported');
    return null;
  }
  return message;
}

/** Answers one `/v1/mcp` request. Never throws: a failure is a 500 with no detail. */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpHttpDeps,
): Promise<void> {
  try {
    // No stream to open and no session to end, so only POST means anything here.
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
    }
    const principal = await authorize(req, res, deps);
    if (!principal) return;
    const message = await readMessage(req, res);
    if (message === null) return;

    const plan = await deps.entitlements?.(principal.orgId);
    const gone = new AbortController();
    const server = new McpServer({ name: 'iris', version: packageVersion() });
    registerHostedTools(server, {
      jobs: deps.jobs.forOrg({ orgId: principal.orgId, apiKeyId: principal.keyId }),
      maxOutstanding: deps.maxQueuedJobsPerOrg,
      monthlyRunLimit: plan?.runsPerMonth,
      waitMs: deps.waitMs,
      gone: gone.signal,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      gone.abort();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, message);
  } catch (err) {
    log('error', 'mcp request failed', {
      requestId: res.getHeader('x-request-id'),
      err: errMessage(err),
    });
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    else res.end();
  }
}
