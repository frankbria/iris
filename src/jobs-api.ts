import type { IncomingMessage, ServerResponse } from 'http';
import { z } from 'zod';
import {
  InvalidCursorError,
  RunQuotaExceededError,
  type A11yJobParams,
  type JobSpec,
  type VisualJobParams,
  type OrgJobs,
  type PostgresHistory,
  type TenantScope,
} from './history-store';
import type { Authenticator, Principal } from './protocol';
import { errMessage, log, redactStrings } from './log';
import { signRunArtifacts, type ArtifactStore } from './artifact-store';

/**
 * The hosted job REST API (#267, ADR 0001 §1): `POST /v1/a11y/jobs` queues a scan,
 * `GET /v1/jobs/:id` reads it back. The results API (#269): `GET /v1/runs` lists the
 * org's finished runs, `GET /v1/runs/:id` reads one with its results. It shares the RPC server's HTTP listener, API-key
 * authentication and per-key / per-org request budgets. No CORS: API clients only.
 */

export const MAX_BODY_BYTES = 64 * 1024;

const Impact = z.enum(['critical', 'serious', 'moderate', 'minor']);

const JobUrls = z
  .array(
    z
      .string()
      .max(2048)
      .refine((u) => /^https?:\/\//i.test(u) && URL.canParse(u), 'must be an http(s) URL')
      // Params and results are stored and readable by the whole org.
      .refine((u) => {
        const url = URL.parse(u);
        return !url || (!url.username && !url.password);
      }, 'must not contain credentials'),
  )
  .min(1)
  .max(20);

const A11yJobBody = z
  .object({
    urls: JobUrls,
    wcagLevel: z.enum(['A', 'AA', 'AAA']).default('AA'),
    failOn: z.array(Impact).min(1).default(['critical', 'serious']),
  })
  .strict();

/** `POST /v1/visual/jobs` (#268). The project names the baselines; it is a key segment. */
const VisualJobBody = z
  .object({
    project: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 of A-Z a-z 0-9 _ -'),
    urls: JobUrls.transform((u) => [...new Set(u)]),
    devices: z
      .array(z.enum(['desktop', 'laptop', 'tablet', 'mobile']))
      .min(1)
      .max(4)
      .default(['desktop'])
      .transform((d) => [...new Set(d)]),
    threshold: z.number().min(0).max(1).default(0.01),
  })
  .strict();

/** `GET /v1/runs` query (#269): every field optional, unknown ones refused. */
const RunListQuery = z
  .object({
    // Plain digits only: Number() would read `0x10` and `1e1`.
    limit: z
      .string()
      .regex(/^\d{1,3}$/, 'must be a whole number')
      .transform(Number)
      .pipe(z.number().min(1).max(100))
      .optional(),
    kind: z.enum(['rpc', 'a11y', 'visual']).optional(),
    status: z.enum(['succeeded', 'failed', 'canceled']).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(512).optional(),
  })
  .strict();

/** The run reads the results API needs: the hosted history, per org. */
export type RunReader = {
  forOrg(scope: TenantScope): Pick<ReturnType<PostgresHistory['forOrg']>, 'listPage' | 'get'>;
};

/** What the API needs of a tenant's jobs; approval only when visual jobs exist (#268). */
export type ApiJobs = Pick<OrgJobs, 'enqueue' | 'get'> &
  Partial<Pick<OrgJobs, 'approveVisualResult'>>;

export interface JobsApiDeps {
  authenticate: Authenticator;
  jobs: { forOrg(scope: TenantScope): ApiJobs };
  /** The results API (#269); without it `/v1/runs` is not served. */
  runs?: RunReader;
  /** Signs the artifacts in run detail (#460); without it run detail carries none. */
  artifacts?: ArtifactStore;
  /** Lifetime of those URLs in seconds (default 5 minutes, at most 15). */
  artifactUrlTtlSeconds?: number;
  /** The org's plan limits (#346); without it no monthly run limit applies. */
  entitlements?: (orgId: string) => Promise<{ runsPerMonth: number }>;
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
const RUN_PATH = /^\/v1\/runs\/([^/]+)$/;
const APPROVE_PATH = /^\/v1\/runs\/([^/]+)\/results\/(\d{1,4})\/approve$/;

/** Answers one non-upgrade HTTP request. Never throws: a failure is a 500 with no detail. */
export async function handleJobsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: JobsApiDeps,
): Promise<void> {
  try {
    const [path, search = ''] = (req.url ?? '').split('?');
    const submitKind =
      path === '/v1/a11y/jobs' ? 'a11y' : path === '/v1/visual/jobs' ? 'visual' : null;
    const isSubmit = submitKind !== null;
    const read = JOB_PATH.exec(path);
    const listRuns = deps.runs !== undefined && path === '/v1/runs';
    const readRun = deps.runs === undefined ? null : RUN_PATH.exec(path);
    const approve = APPROVE_PATH.exec(path);
    if (!isSubmit && !read && !listRuns && !readRun && !approve)
      return send(res, 404, { error: 'Not found' });
    const method = isSubmit || approve ? 'POST' : 'GET';
    if (req.method !== method) {
      return send(res, 405, { error: 'Method not allowed' }, { allow: method });
    }

    // Verification hits the shared auth pool: unauthenticated floods must not queue on it.
    const release = deps.admit();
    if (!release) {
      return send(res, 503, { error: 'Server busy' }, { 'retry-after': '1' });
    }
    let principal: Principal | 'suspended' | null;
    try {
      principal = await deps.authenticate.verify(req.headers.authorization);
    } catch {
      return send(res, 503, { error: 'Authentication unavailable' });
    } finally {
      release();
    }
    if (!principal) return send(res, 401, { error: 'Unauthorized' });
    // Reads and submits alike (#348); the operator's reason is never sent.
    if (principal === 'suspended') return send(res, 403, { error: 'Organization suspended' });

    const wait = deps.charge(principal);
    if (wait > 0) {
      return send(
        res,
        429,
        { error: 'Rate limit exceeded' },
        { 'retry-after': String(Math.ceil(wait / 1000)) },
      );
    }
    const scope = { orgId: principal.orgId, apiKeyId: principal.keyId };

    if (listRuns) {
      const params = new URLSearchParams(search);
      // Object.fromEntries keeps the last of a repeated parameter: refuse instead.
      const repeated = [...new Set(params.keys())].find((k) => params.getAll(k).length > 1);
      if (repeated) return send(res, 400, { error: `Invalid query: ${repeated}: repeated` });
      const query = RunListQuery.safeParse(Object.fromEntries(params));
      if (!query.success) {
        const issue = query.error.issues[0];
        return send(res, 400, {
          error: `Invalid query: ${[...issue.path, issue.message].join(': ')}`,
        });
      }
      const { from, to, ...rest } = query.data;
      try {
        const page = await deps.runs!.forOrg(scope).listPage({
          ...rest,
          ...(from && { from: new Date(from) }),
          ...(to && { to: new Date(to) }),
        });
        return send(res, 200, page);
      } catch (err) {
        if (err instanceof InvalidCursorError) return send(res, 400, { error: 'Invalid cursor' });
        throw err;
      }
    }
    if (readRun) {
      let id: string;
      try {
        id = decodeURIComponent(readRun[1]);
      } catch {
        return send(res, 404, { error: 'Not found' });
      }
      const run = await deps.runs!.forOrg(scope).get(id);
      if (!run) return send(res, 404, { error: 'Not found' });
      // Every key of the org reads this. #254 stored the run without typed values or URL
      // userinfo; secret-looking query values (a reset link's token) are cut here too.
      // Artifact keys are taken out first (a key segment can look like an API key, which
      // redaction would rewrite), and signed after: redaction would cut X-Amz-Signature.
      const keysByResult = run.results.map((r) => {
        const result = r.result && typeof r.result === 'object' ? r.result : {};
        const { artifacts, ...rest } = result as Record<string, unknown>;
        r.result = rest; // raw keys never leave; signed URLs replace them below
        return artifacts;
      });
      const body = redactStrings(run) as typeof run;
      for (const [i, artifacts] of keysByResult.entries()) {
        if (artifacts === undefined || !deps.artifacts) continue;
        const { signed, dropped } = await signRunArtifacts(
          deps.artifacts,
          { orgId: scope.orgId, runId: run.id },
          artifacts,
          deps.artifactUrlTtlSeconds,
        );
        body.results[i].result = { ...body.results[i].result, artifacts: signed };
        if (dropped.length)
          log('warn', 'run artifacts not signed', { orgId: scope.orgId, runId: run.id, dropped });
      }
      return send(res, 200, body);
    }

    const store = deps.jobs.forOrg(scope);

    if (approve) {
      // Approval writes a baseline image: without a store there is nothing to approve.
      if (!deps.artifacts || !store.approveVisualResult)
        return send(res, 503, { error: 'Visual baselines are not configured' });
      let runId: string;
      try {
        runId = decodeURIComponent(approve[1]);
      } catch {
        return send(res, 404, { error: 'Not found' });
      }
      const outcome = await store.approveVisualResult(runId, Number(approve[2]), deps.artifacts);
      if (outcome.status === 'not-found') return send(res, 404, { error: 'Not found' });
      if (outcome.status === 'conflict') return send(res, 409, { error: outcome.reason });
      const b = outcome.baseline;
      return send(res, 200, {
        project: b.project,
        page: b.page,
        device: b.device,
        approvedAt: b.updatedAt,
      });
    }

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
    // A visual job's images need a store; refuse it rather than queue it forever.
    if (submitKind === 'visual' && !deps.artifacts)
      return send(res, 503, { error: 'Visual jobs are not configured' });
    const parsed = (submitKind === 'visual' ? VisualJobBody : A11yJobBody).safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return send(res, 400, {
        error: `Invalid request: ${[...issue.path, issue.message].join(': ')}`,
      });
    }
    const spec = (
      submitKind === 'visual'
        ? { kind: 'visual', params: parsed.data as VisualJobParams }
        : { kind: 'a11y', params: parsed.data as A11yJobParams }
    ) as JobSpec;
    const monthlyRunLimit = deps.entitlements
      ? (await deps.entitlements(scope.orgId)).runsPerMonth
      : undefined;
    let id: string | null;
    try {
      id = await store.enqueue(spec, {
        maxOutstanding: deps.maxQueuedJobsPerOrg,
        monthlyRunLimit,
      });
    } catch (err) {
      if (!(err instanceof RunQuotaExceededError)) throw err;
      // 402: a plan limit, not a rate (#346). The org upgrades or waits for the month.
      return send(res, 402, { error: err.message, limit: err.limit, used: err.used });
    }
    if (id === null) return send(res, 429, { error: 'Too many queued jobs' });
    return send(res, 202, { id, status: 'queued' });
  } catch (err) {
    log('error', 'job API request failed', {
      requestId: res.getHeader('x-request-id'),
      err: errMessage(err),
    });
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    else res.end();
  }
}
