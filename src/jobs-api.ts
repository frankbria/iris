import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import type { A11yJobParams, OrgJobs, TenantScope } from './history-store';
import type { Authenticator, Principal } from './protocol';

/**
 * The hosted job REST API (#267, ADR 0001 §1): `POST /v1/a11y/jobs` queues a scan,
 * `GET /v1/jobs/:id` reads it back. It shares the RPC server's HTTP listener, API-key
 * authentication and per-key / per-org request budgets. No CORS: API clients only.
 */

export const MAX_BODY_BYTES = 64 * 1024;

const Impact = z.enum(['critical', 'serious', 'moderate', 'minor']);

const A11yJobBody = z
  .object({
    urls: z
      .array(
        z
          .string()
          .max(2048)
          .refine((u) => /^https?:\/\//i.test(u) && URL.canParse(u), 'must be an http(s) URL'),
      )
      .min(1)
      .max(20),
    wcagLevel: z.enum(['A', 'AA', 'AAA']).default('AA'),
    failOn: z.array(Impact).min(1).default(['critical', 'serious']),
  })
  .strict();

export interface JobsApiDeps {
  authenticate: Authenticator;
  jobs: { forOrg(scope: TenantScope): OrgJobs };
  /** Spends a request from the principal's key and org budgets; milliseconds to wait if refused, else 0. */
  charge(principal: Principal): number;
  /**
   * Takes one of the server's pending-verification slots (shared with WebSocket
   * upgrades); `null` when none is free. Call the returned function to give it back.
   */
  admit(): (() => void) | null;
  /** Queued + running jobs one org may have; the next submit gets 429. */
  maxQueuedJobsPerOrg: number;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** The body as text, or `null` once it passes `MAX_BODY_BYTES` (the rest is discarded). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        resolve(null);
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const JOB_PATH = /^\/v1\/jobs\/([^/]+)$/;

/** Answers one non-upgrade HTTP request. Never throws: a failure is a 500 with no detail. */
export async function handleJobsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: JobsApiDeps,
): Promise<void> {
  try {
    const path = (req.url ?? '').split('?')[0];
    const isSubmit = path === '/v1/a11y/jobs';
    const read = JOB_PATH.exec(path);
    if (!isSubmit && !read) return send(res, 404, { error: 'Not found' });
    const method = isSubmit ? 'POST' : 'GET';
    if (req.method !== method) {
      return send(res, 405, { error: 'Method not allowed' }, { allow: method });
    }

    // Verification hits the shared auth pool: unauthenticated floods must not queue on it.
    const release = deps.admit();
    if (!release) {
      return send(res, 503, { error: 'Server busy' }, { 'retry-after': '1' });
    }
    let principal: Principal | null;
    try {
      principal = await deps.authenticate.verify(req.headers.authorization);
    } catch {
      return send(res, 503, { error: 'Authentication unavailable' });
    } finally {
      release();
    }
    if (!principal) return send(res, 401, { error: 'Unauthorized' });

    const wait = deps.charge(principal);
    if (wait > 0) {
      return send(
        res,
        429,
        { error: 'Rate limit exceeded' },
        { 'retry-after': String(Math.ceil(wait / 1000)) },
      );
    }
    const store = deps.jobs.forOrg({ orgId: principal.orgId, apiKeyId: principal.keyId });

    if (read) {
      let id: string;
      try {
        id = decodeURIComponent(read[1]);
      } catch {
        return send(res, 404, { error: 'Not found' });
      }
      const job = await store.get(id);
      if (!job) return send(res, 404, { error: 'Not found' });
      return send(res, 200, {
        id: job.id,
        kind: job.kind,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        ...(job.summary !== null && { summary: job.summary }),
        ...(job.error !== null && { error: job.error }),
        ...(job.finishedAt && job.error === null && { results: job.results }),
      });
    }

    const text = await readBody(req);
    if (text === null) return send(res, 413, { error: 'Request body too large' });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return send(res, 400, { error: 'Body is not valid JSON' });
    }
    const parsed = A11yJobBody.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return send(res, 400, {
        error: `Invalid request: ${[...issue.path, issue.message].join(': ')}`,
      });
    }
    const params: A11yJobParams = parsed.data;
    const id = await store.enqueue(
      { kind: 'a11y', params },
      { maxOutstanding: deps.maxQueuedJobsPerOrg },
    );
    if (id === null) return send(res, 429, { error: 'Too many queued jobs' });
    return send(res, 202, { id, status: 'queued' });
  } catch (err) {
    console.error('[iris] job API request failed:', (err as Error).message);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    else res.end();
  }
}
