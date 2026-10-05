import WebSocket, { WebSocketServer } from 'ws';
import { createServer, IncomingMessage, STATUS_CODES } from 'http';
import { handleJobsRequest, type ApiJobs, type RunReader } from './jobs-api';
import type { ArtifactStore } from './artifact-store';
import { randomUUID, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { translateSync, translate, Action, ActionSchema } from './translator';
import {
  ActionExecutor,
  ExecutionResult,
  ActionExecutorOptions,
  EXECUTOR_DEFAULTS,
} from './executor';
import { chromiumIsInstalled } from './browser';
import { Page } from 'playwright';
import type { HistoryStore, TenantScope } from './history-store';
import type { AICredentials } from './ai-client/credentials';
import type { UsageEvent } from './billing/usage';
import type { SettledAICall } from './ai-client/factory';
import { errMessage, log } from './log';
import { metrics, REQUEST_BUCKETS } from './metrics';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

// RPC param schemas — validated at the dispatch boundary so handlers never
// receive unvalidated input from the wire.
const ExecuteCommandParams = z.object({ instruction: z.string().min(1) });

// Structural validation of wire actions uses the SAME schema the Action union is
// defined with (translator.ts). This file used to keep its own copy, which meant
// any new action type was silently rejected here until someone remembered to
// update both. Scheme/host policy (SSRF, file://) is still enforced downstream at
// the performAction navigate boundary.

// launchBrowser options are wire-controlled, so whitelist them. zod strips
// unknown keys by default — critically dropping any client-supplied `urlPolicy`
// (e.g. `allowFile: true`), so the RPC path can never opt out of the secure
// default navigation policy on this unauthenticated surface.
//
// Ceilings are not here: timings are clamped to the server's `ServerLimits`
// after parsing (#338). The schema only rejects values that are wrong at any
// size — timeout:0 would disable the page timeout and hang the executor.
const LaunchBrowserOptions = z.object({
  retryAttempts: z.number().int().min(0).optional(),
  retryDelay: z.number().int().min(0).optional(),
  timeout: z.number().int().positive().optional(),
  trackContext: z.boolean().optional(),
  browserOptions: z
    .object({
      // A visible browser or devtools window is an operator's local debugging
      // aid, never something a wire client may ask a server for (#338).
      headless: z.literal(true).optional(),
      devtools: z.literal(false).optional(),
      slowMo: z.number().int().min(0).optional(),
    })
    .optional(),
});

const ExecuteBrowserActionParams = z.object({
  instruction: z.string().optional(),
  actions: z.array(ActionSchema).optional(),
  // Structural check on the optional context url; full scheme/host policy is
  // applied where navigation actually happens (performAction / url-policy).
  url: z
    .string()
    .url()
    .refine((u) => /^https?:$/.test(new URL(u).protocol))
    .optional(),
});

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  /** `null` only when the request's id could not be read (JSON-RPC 2.0 §5). */
  id: number | string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error?: { code: number; message: string; data?: any };
}

export interface BrowserSession {
  executor: ActionExecutor;
  page: Page | null;
  /** In-flight lazy page creation, cached so pipelined first actions share one page. */
  pageCreationPromise: Promise<Page> | null;
  isActive: boolean;
  lastActivity: number;
  /** Requests running on this session; the inactivity sweep skips it while any are (#240). */
  busy: number;
  /** The tenant whose key opened the connection (#341); unset under the shared token. */
  principal?: Principal;
  /** Names the session's usage row, so it is recorded once (#263). */
  id: string;
  /**
   * Browser minutes are billed up to here (#263): set when the first page is created,
   * advanced by each recorded segment.
   */
  billedUntil?: number;
  /** Segments recorded so far: each one's idempotency key is `session:<id>:<n>`. */
  billedSegments: number;
  /** Called once, when the session ends, whichever path ends it. */
  onEnd?: (session: BrowserSession) => void;
}

/** Who a connection acts for: the org that owns its API key, and the key (#341). */
/**
 * A tenant's AI credential for one request (#258) with whose account pays for it (#479).
 * The mode is required: a managed key recorded as `byok` would never count against the
 * org's credit.
 */
export type TenantCredentials = AICredentials & { billingMode: 'byok' | 'managed' };

export interface Principal {
  orgId: string;
  keyId: string;
  /** The org plan's concurrent sessions (#346); the operator's `maxSessionsPerOrg` still caps it. */
  maxSessions?: number;
}

/** Per-tenant authentication for hosted connections (#341). */
export interface Authenticator {
  /**
   * Checks a connection's `Authorization` header at the upgrade. Resolves to the
   * tenant on a valid key, to `'suspended'` on a valid key of a suspended org (#348:
   * HTTP 403), and to `null` on any other header. Throws only when it cannot decide
   * (the key store is unreachable), which the server answers with 503.
   */
  verify(authorization: string | undefined): Promise<Principal | 'suspended' | null>;
  /**
   * Whether a connected principal's key is still valid, by key id: read-only, and
   * without the key itself, which a connection therefore does not keep (#342).
   * `'suspended'` when the key is fine but its org is suspended (#348).
   * Throws when it cannot tell, and the connection is kept until the next round.
   */
  recheck(principal: Principal): Promise<boolean | 'suspended'>;
}

export interface BrowserStatus {
  isActive: boolean;
  hasPage: boolean;
  lastActivity: number;
  context?: {
    url?: string;
    title?: string;
  };
}

/**
 * Server-side resource limits (#338). Every one bounds something a wire client
 * could otherwise make unbounded: memory per frame, sockets, Chromium processes,
 * work per request, and how long one action may hold a session.
 */
export interface ServerLimits {
  /** Largest accepted frame; a bigger one closes the socket with 1009. ws's own default is 100 MiB. */
  maxPayloadBytes: number;
  /** Open sockets; the next upgrade gets HTTP 503. */
  maxConnections: number;
  /**
   * Browser sessions across the whole server — each can hold a Chromium. A
   * connection has at most one (launchBrowser replaces it), so this is the cap
   * that bounds browsers, not a per-connection count.
   */
  maxSessions: number;
  /** Length of an `executeBrowserAction` `actions` array. */
  maxActionsPerRequest: number;
  /** Ceilings the wire's launch options are clamped to. */
  maxTimeoutMs: number;
  maxRetryAttempts: number;
  maxRetryDelayMs: number;
  maxSlowMoMs: number;
  /** Ping interval; a peer that has not answered the previous ping is terminated. */
  heartbeatIntervalMs: number;
  /**
   * Tenant limits (#342), applied to hosted connections only (a principal from an
   * API key). Requests per minute per key and per org, so an org cannot multiply
   * its rate by minting keys; over either, a request gets `-32029` and is not run.
   */
  keyRequestsPerMinute: number;
  orgRequestsPerMinute: number;
  /** Browser sessions one org may hold, so it cannot take every `maxSessions` slot. */
  maxSessionsPerOrg: number;
  /** Connections one org may hold; the next upgrade gets HTTP 429. */
  maxConnectionsPerOrg: number;
  /** Queued + running jobs one org may have (#267); the next submit gets HTTP 429. */
  maxQueuedJobsPerOrg: number;
}

/**
 * Sized for the staging container (3 GB, 2 CPUs): a Chromium session costs a few
 * hundred MB, so four leaves headroom for the server and the egress proxy.
 */
export const DEFAULT_SERVER_LIMITS: Readonly<ServerLimits> = Object.freeze({
  maxPayloadBytes: 1024 * 1024,
  maxConnections: 16,
  maxSessions: 4,
  maxActionsPerRequest: 100,
  maxTimeoutMs: 120_000,
  maxRetryAttempts: 5,
  maxRetryDelayMs: 10_000,
  maxSlowMoMs: 1_000,
  heartbeatIntervalMs: 30_000,
  keyRequestsPerMinute: 120,
  orgRequestsPerMinute: 300,
  maxSessionsPerOrg: 2,
  maxConnectionsPerOrg: 8,
  maxQueuedJobsPerOrg: 10,
});

/** JSON-RPC error code for a request refused by a rate limit (#342). */
export const RATE_LIMITED = -32029;

// Observability (#275). Labels are bounded: a method the server knows, or `unknown`.
const RPC_METHODS = new Set([
  'executeCommand',
  'launchBrowser',
  'closeBrowser',
  'getBrowserStatus',
  'executeBrowserAction',
  'getStatus',
]);
const requestsTotal = metrics.counter(
  'iris_requests_total',
  'Requests answered, by RPC method or REST route, and outcome (ok, client_error, rate_limited, error)',
);
const requestSeconds = metrics.histogram(
  'iris_request_duration_seconds',
  'Request latency, by RPC method or REST route',
  REQUEST_BUCKETS,
);
const aiSpend = metrics.counter(
  'iris_ai_spend_usd_total',
  'Provider cost of settled AI calls, USD, by provider, usage kind and billing mode',
);

/** How a request ended, for logs and metrics. */
type Outcome = 'ok' | 'client_error' | 'rate_limited' | 'aborted' | 'error';

/**
 * `executeBrowserActions` answers every failure as `{ success: false, error }`, which a
 * client already relies on. The outcome of the ones that are not "ok" rides beside the
 * reply here, never in it: a server fault (Chromium would not start, the browser died,
 * translation threw) is `error`, so the error rate sees a browser outage (#275).
 */
const resultOutcome = new WeakMap<object, Outcome>();
const tagged = <T extends object>(result: T, outcome: Outcome): T => {
  resultOutcome.set(result, outcome);
  return result;
};

/** A JSON-RPC answer's outcome: the client's own mistakes are not server errors. */
function rpcOutcome(code: number | undefined): Outcome {
  if (code === undefined) return 'ok';
  if (code === RATE_LIMITED) return 'rate_limited';
  if (code === -32600 || code === -32601 || code === -32602) return 'client_error';
  return 'error';
}

/** A known method name from a parsed frame, else `unknown`: the label set stays bounded. */
function rpcMethod(parsed: unknown): string {
  const method = (parsed as { method?: unknown } | null)?.method;
  return typeof method === 'string' && RPC_METHODS.has(method) ? method : 'unknown';
}

/** The tenant fields of a log line: org and key id, never the key. */
const who = (principal?: Principal) =>
  principal ? { orgId: principal.orgId, keyId: principal.keyId } : {};

/** One line and one sample per answered request. Synchronous: no await ahead of the gate. */
function observeRequest(
  kind: 'rpc' | 'rest',
  method: string,
  outcome: Outcome,
  startedAt: number,
  fields: Record<string, unknown>,
  /** False: counted, but no line (a throttled refusal, or a server already closed). */
  print = true,
): void {
  const seconds = Math.max(0, (performance.now() - startedAt) / 1000);
  requestsTotal.inc({ method, outcome });
  requestSeconds.observe({ method }, seconds);
  if (!print) return;
  log(outcome === 'error' ? 'warn' : 'info', `${kind} request`, {
    method,
    outcome,
    latencyMs: Math.round(seconds * 1000),
    ...fields,
  });
}

/**
 * Refusals answered before dispatch (rate-limited, unparseable, not a request) cost a
 * client nothing to send, so per connection only one line per interval is printed,
 * carrying how many were suppressed since the last; every one is still counted.
 */
const REFUSAL_LOG_MS = 10_000;

/** A client-sent `X-Request-Id` is logged (as `clientRequestId`) only if short and plain. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** The REST route a request names, with ids folded so the label set stays bounded. */
function restRoute(req: IncomingMessage): string {
  const path = (req.url ?? '').split('?')[0];
  const route =
    path === '/v1/a11y/jobs' || path === '/v1/runs'
      ? path
      : /^\/v1\/jobs\/[^/]+$/.test(path)
        ? '/v1/jobs/:id'
        : /^\/v1\/runs\/[^/]+$/.test(path)
          ? '/v1/runs/:id'
          : 'other';
  const method = ['GET', 'POST', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
    req.method ?? '',
  )
    ? req.method
    : 'OTHER';
  return `${method} ${route}`;
}

/**
 * Request budgets, one token bucket per id (#342). A bucket holds up to a minute's
 * worth and refills continuously, so a burst is allowed and the sustained rate is
 * `perMinute`. Checking is synchronous: an await ahead of the SessionGate would
 * reorder pipelined messages (#128). Times are `performance.now()`, a monotonic
 * clock: on wall time, a clock stepping backward (WSL2 does, #190) would subtract
 * tokens, and one stepping forward would hand them out.
 *
 * ponytail: in memory, so the budget is per server process; several processes need
 * a shared store (#316).
 */
class RateBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly perMinute: number) {}

  private refill(id: string, now: number) {
    const bucket = this.buckets.get(id) ?? { tokens: this.perMinute, at: now };
    bucket.tokens = Math.min(
      this.perMinute,
      bucket.tokens + ((now - bucket.at) * this.perMinute) / 60_000,
    );
    bucket.at = now;
    this.buckets.set(id, bucket);
    return bucket;
  }

  /** Milliseconds until `id` has a whole token; 0 when it has one now. */
  wait(id: string, now: number): number {
    const { tokens } = this.refill(id, now);
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) * 60_000) / this.perMinute);
  }

  /** Spend a token `wait()` just reported. */
  take(id: string): void {
    this.buckets.get(id)!.tokens -= 1;
  }

  /** Forget refilled buckets: a full one is the same as none, so reconnecting gains nothing. */
  prune(now: number): void {
    for (const id of [...this.buckets.keys()]) {
      if (this.refill(id, now).tokens >= this.perMinute) this.buckets.delete(id);
    }
  }
}

/**
 * The container healthcheck's reserved slot (#342): a loopback peer that says it is
 * the probe may connect one beyond `maxConnections`, so a full server does not read
 * as unhealthy. Loopback only, because a published port arrives on the container's
 * network interface, never on its loopback (#192).
 */
function isProbe(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  const loopback =
    address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
  return loopback && req.headers['x-iris-probe'] === '1';
}

/**
 * Start a JSON-RPC 2.0 over WebSocket server on the given port.
 */
export function startServer(
  port: number,
  options?: {
    sessionTimeout?: number;
    host?: string;
    allowedOrigins?: string[];
    /** Local mode: one shared bearer token. */
    authToken?: string;
    /** Hosted mode: per-tenant API keys (#341). Exclusive with `authToken`. */
    authenticate?: Authenticator;
    /** How often a connected key is verified again, so revoking it ends the connection. */
    authRecheckMs?: number;
    /**
     * Hosted run history (#254): each `executeBrowserAction` of a tenant connection
     * is recorded under its org and API key. Local connections record nothing.
     */
    history?: { forOrg(scope: TenantScope): Pick<HistoryStore, 'record'> };
    /**
     * A tenant's AI credentials (#258): BYOK (#344) or managed credits (#346). `null`,
     * or no resolver at all, means the tenant has no AI: its instructions get pattern
     * translation only, and the process-wide `*_API_KEY` is never used for it
     * (ADR 0001 §5). Local (token) connections keep the process configuration.
     */
    aiCredentials?: (principal: Principal) => Promise<TenantCredentials | null>;
    /**
     * The usage ledger (#263): a tenant session's browser minutes when it ends, and
     * each AI call its translations make. Local connections record nothing.
     */
    usage?: { record(orgId: string, events: UsageEvent[]): Promise<void> };
    /**
     * How often an open tenant session's browser minutes are written (#263), so a
     * crash or a forced restart loses at most one interval, and a session spanning a
     * month boundary is billed to both months.
     */
    usageCheckpointMs?: number;
    /**
     * The hosted job API (#267), served over HTTP on the same port: `POST
     * /v1/a11y/jobs`, `GET /v1/jobs/:id`. Needs `authenticate`; it shares the key and
     * org request budgets with the RPC messages. Unset, plain HTTP gets 426 as before.
     */
    jobs?: { forOrg(scope: TenantScope): ApiJobs };
    /** The results API (#269), `GET /v1/runs[/:id]`, served beside the job API. */
    runs?: RunReader;
    /** Signs run-detail artifacts (#460); unset, run detail carries none. */
    artifacts?: ArtifactStore;
    /** The org's plan limits for job submits (#346). */
    entitlements?: (orgId: string) => Promise<{ runsPerMonth: number }>;
    /** Signed URL lifetime in seconds (default 300, at most 900). */
    artifactUrlTtlSeconds?: number;
    /** Overrides for any subset of `DEFAULT_SERVER_LIMITS`. */
    limits?: Partial<ServerLimits>;
  },
): WebSocketServer {
  const authenticate = options?.authenticate;
  if (authenticate && options?.authToken) {
    throw new Error('Pass authToken or authenticate, one at a time');
  }
  if (options?.jobs && !authenticate) throw new Error('The job API needs authenticate');
  const host = options?.host ?? '127.0.0.1';
  const limits: ServerLimits = { ...DEFAULT_SERVER_LIMITS, ...options?.limits };
  const allowedOrigins = options?.allowedOrigins ?? [];
  const ActionParams = ExecuteBrowserActionParams.extend({
    actions: z.array(ActionSchema).max(limits.maxActionsPerRequest).optional(),
  });
  /** Set once the server has closed; request lines are no longer printed. */
  let closed = false;
  /** Verified upgrades, read back by the 'connection' handler. */
  const verified = new WeakMap<IncomingMessage, Principal>();
  /** Upgrades whose key is still being verified; they count against the connection cap. */
  let verifying = 0;

  // One listener for both: the WebSocket upgrade, and the job REST API (#267).
  const server = createServer((req, res) => {
    // One line per REST request, with the id echoed back so a client can quote it (#275).
    const t0 = performance.now();
    // Ours is always generated (a client's could collide with another's); a safe
    // client id is logged beside it.
    const sent = req.headers['x-request-id'];
    const clientRequestId =
      typeof sent === 'string' && SAFE_REQUEST_ID.test(sent) ? sent : undefined;
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    let tenant: Principal | undefined;
    let rateLimited = false;
    res.on('close', () => {
      const status = res.writableFinished ? res.statusCode : undefined;
      const outcome: Outcome =
        status === undefined
          ? 'aborted' // the client went away before the answer: not ours to count as an error
          : status >= 500
            ? 'error'
            : rateLimited
              ? 'rate_limited'
              : status >= 400
                ? 'client_error'
                : 'ok';
      observeRequest(
        'rest',
        restRoute(req),
        outcome,
        t0,
        { requestId, clientRequestId, status: status ?? 'aborted', ...who(tenant) },
        !closed,
      );
    });
    if (options?.jobs) {
      void handleJobsRequest(req, res, {
        authenticate: authenticate!,
        jobs: options.jobs,
        runs: options.runs,
        artifacts: options.artifacts,
        artifactUrlTtlSeconds: options.artifactUrlTtlSeconds,
        entitlements: options.entitlements,
        maxQueuedJobsPerOrg: limits.maxQueuedJobsPerOrg,
        // REST verifications share the upgrades' `verifying` count, so a bad-key flood
        // cannot pile onto the auth pool. Only pending ones count here: idle sockets
        // should not make the API unavailable.
        admit: () => {
          if (verifying >= limits.maxConnections) return null;
          verifying++;
          return () => {
            verifying--;
          };
        },
        charge: (principal) => {
          tenant = principal;
          // Both buckets need a token before either is spent (see the RPC path).
          const now = performance.now();
          const wait = Math.max(
            keyRate.wait(principal.keyId, now),
            orgRate.wait(principal.orgId, now),
          );
          if (wait === 0) {
            keyRate.take(principal.keyId);
            orgRate.take(principal.orgId);
          } else rateLimited = true;
          return wait;
        },
      });
      return;
    }
    // What ws answers a plain HTTP request with when it owns the listener.
    res.writeHead(426, {
      'content-type': 'text/plain',
      'content-length': STATUS_CODES[426]!.length,
    });
    res.end(STATUS_CODES[426]);
  });
  const wss: WebSocketServer = new WebSocketServer({
    server,
    maxPayload: limits.maxPayloadBytes,
    // Every check runs before the upgrade completes, so a refused client never
    // holds a socket, a message listener or a connection slot (#338). This used
    // to accept first and close with 1008 after. Up to the key check everything is
    // synchronous, so the connection count read here cannot change before ws adds
    // the client; a key check is async, so upgrades in it are counted as `verifying`.
    verifyClient: ({ req }, done) => {
      // Reject cross-site WebSocket hijacking: a browser page connecting to
      // localhost sends an Origin header; trusted local tooling sends none.
      const origin = req.headers.origin;
      // Refusals are logged with their reason only; never the header that was refused.
      const refuse = (status: number, message: string, reason: string) => {
        log('info', 'connection refused', { reason, status });
        done(false, status, message);
      };
      if (origin && !allowedOrigins.includes(origin)) {
        return refuse(403, 'Origin not allowed', 'origin');
      }
      // The token travels in the Authorization header, which a browser page
      // cannot set on a WebSocket. Absent Origin is NOT treated as trusted: no
      // token means rejected.
      if (options?.authToken && !hasValidToken(req.headers.authorization, options.authToken)) {
        return refuse(401, 'Unauthorized', 'token');
      }
      const cap = limits.maxConnections + (isProbe(req) ? 1 : 0);
      if (wss.clients.size + verifying >= cap) {
        return refuse(503, 'Connection limit reached', 'connection_limit');
      }
      if (!authenticate) return done(true);
      verifying++;
      authenticate.verify(req.headers.authorization).then(
        (principal) => {
          // Decrement right before done(): ws adds an accepted client synchronously,
          // and its 'connection' handler registers it in `tenants` before returning,
          // so the org count below cannot miss a client admitted a moment earlier.
          verifying--;
          if (!principal) return refuse(401, 'Unauthorized', 'invalid_key');
          // A valid key of a suspended org (#348): 403, never the operator's reason.
          if (principal === 'suspended') return refuse(403, 'Organization suspended', 'suspended');
          const orgConnections = [...tenants.values()].filter(
            (t) => t.orgId === principal.orgId,
          ).length;
          if (orgConnections >= limits.maxConnectionsPerOrg) {
            log('info', 'connection refused', {
              reason: 'org_connection_limit',
              status: 429,
              ...who(principal),
            });
            return done(false, 429, 'Organization connection limit reached');
          }
          verified.set(req, principal);
          done(true);
        },
        (err: unknown) => {
          verifying--;
          log('warn', 'connection refused', {
            reason: 'auth_unavailable',
            status: 503,
            err: errMessage(err),
          });
          done(false, 503, 'Authentication unavailable');
        },
      );
    },
  });
  /** Each tenant connection's principal, re-checked every `authRecheckMs`. */
  const tenants = new Map<WebSocket, Principal>();
  const keyRate = new RateBuckets(limits.keyRequestsPerMinute);
  const orgRate = new RateBuckets(limits.orgRequestsPerMinute);
  /**
   * A tenant session's browser minutes, recorded when it ends (#263): from its first
   * page to the end, and only if a browser ever started. A failed write is logged.
   */
  /**
   * Record a tenant session's browser minutes since it was last billed, as one segment.
   * Idle time with the browser open counts: Chromium is held for the tenant either way.
   * A failed write is logged.
   */
  const billMinutes = (session: BrowserSession, until: number): void => {
    const principal = session.principal;
    if (!options?.usage || !principal || session.billedUntil === undefined) return;
    // Clamped: a wall clock stepping backward (WSL2 does, #190) would make it negative,
    // and the ledger refuses a negative quantity, losing the segment.
    const minutes = Math.max(0, Math.round(((until - session.billedUntil) / 60_000) * 1e4) / 1e4);
    const segment = session.billedSegments++;
    session.billedUntil = until;
    options.usage
      .record(principal.orgId, [
        {
          kind: 'browser_minutes',
          quantity: minutes,
          idempotencyKey: `session:${session.id}:${segment}`,
        },
      ])
      .catch((err: unknown) =>
        log('error', 'failed to record browser minutes', {
          sessionId: session.id,
          ...who(principal),
          err: errMessage(err),
        }),
      );
  };
  const meterMinutes = (_principal: Principal) => (session: BrowserSession) =>
    billMinutes(session, Date.now());
  const checkpoint = setInterval(
    () => {
      const now = Date.now();
      for (const session of sessions.values()) {
        if (session.isActive) billMinutes(session, now);
      }
    },
    options?.usageCheckpointMs ?? 5 * 60_000,
  );
  checkpoint.unref();
  if (!options?.usage) clearInterval(checkpoint);
  const sessions = new Map<WebSocket, BrowserSession>();
  // Read at scrape time. With several servers in one process (tests), the last one wins.
  metrics.gauge('iris_sessions_active', 'Browser sessions open', () => sessions.size);
  metrics.gauge(
    'iris_browsers_active',
    'Sessions whose browser has started (a page is open)',
    () => [...sessions.values()].filter((s) => s.page !== null && !s.page.isClosed()).length,
  );
  const sessionTimeout = options?.sessionTimeout || 30 * 60 * 1000; // 30 minutes default
  /** Server start, so `getStatus` can report real uptime rather than a constant (issue #80). */
  const startedAt = Date.now();

  // Cleanup inactive sessions periodically
  const cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [ws, session] of sessions.entries()) {
        if (session.busy === 0 && now - session.lastActivity > sessionTimeout) {
          cleanupSession(ws, sessions, 'timeout');
        }
      }
    },
    // Every 5 minutes, or more often when the timeout itself is shorter.
    Math.min(5 * 60 * 1000, sessionTimeout),
  );
  cleanupInterval.unref();

  // Heartbeat: a half-open peer (vanished without a FIN) otherwise pins its
  // browser until the idle sweep, ~35 minutes. A peer that has not answered the
  // previous ping by the next tick is terminated, which fires 'close' and so
  // the ordinary session cleanup.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    keyRate.prune(performance.now());
    orgRate.prune(performance.now());
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        log('info', 'connection terminated: no heartbeat answer', { ...who(tenants.get(ws)) });
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, limits.heartbeatIntervalMs);
  heartbeat.unref();

  // A key revoked or disabled in the portal must end the connections it opened,
  // not only refuse new ones. On a timer rather than per message: an await ahead
  // of the SessionGate would reorder pipelined messages (#128).
  let rechecking = false;
  const recheck = setInterval(async () => {
    if (rechecking) return;
    rechecking = true;
    try {
      await Promise.all(
        [...tenants].map(async ([ws, principal]) => {
          let live: boolean | 'suspended';
          try {
            live = await authenticate!.recheck(principal);
          } catch {
            // ponytail: an unreachable key store keeps connections up; the next round decides.
            return;
          }
          if (live === true) return;
          const reason =
            live === 'suspended' ? 'Organization suspended' : 'API key no longer valid';
          tenants.delete(ws);
          log('info', `connection closed: ${reason}`, { ...who(principal) });
          ws.close(1008, reason);
          // Not waiting for the close handshake: the browser goes now.
          cleanupSession(ws, sessions, 'revoked');
        }),
      );
    } finally {
      rechecking = false;
    }
  }, options?.authRecheckMs ?? 60_000);
  recheck.unref();
  if (!authenticate) clearInterval(recheck);

  wss.on('connection', (ws, req) => {
    const principal = verified.get(req);
    if (principal) tenants.set(ws, principal);
    log('info', 'connection opened', { ...who(principal) });
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    // One gate per connection: sessions are keyed by socket, so ordering only
    // needs to hold within a connection. Scoped to this closure so it dies with
    // the socket rather than needing its own cleanup path.
    const gate = new SessionGate();

    // Pre-dispatch refusals, throttled per connection (REFUSAL_LOG_MS).
    let refusalLineAt = -Infinity;
    let suppressed = 0;
    const refusal = (method: string, outcome: Outcome, t0: number, fields: object) => {
      const now = performance.now();
      const print = now - refusalLineAt >= REFUSAL_LOG_MS;
      observeRequest(
        'rpc',
        method,
        outcome,
        t0,
        { ...fields, ...(print && suppressed > 0 && { suppressed }) },
        print && !closed,
      );
      if (print) {
        refusalLineAt = now;
        suppressed = 0;
      } else suppressed++;
    };

    // A request can outlive its socket: the client may close while a handler
    // is awaiting. ws then buffers the reply for a peer that is gone instead of
    // sending it, so check first (#330).
    const reply = (res: JsonRpcResponse) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
    };

    ws.on('message', async (data) => {
      // Per request (#275): an id for its log line, and the start of its latency.
      const t0 = performance.now();
      const requestId = randomUUID();
      const requestFields = { requestId, ...who(principal) };
      let parsed: unknown;
      let unparseable = false;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        unparseable = true;
      }

      // Tenant request budgets (#342), before anything else, so a malformed frame
      // spends one too. Both must have a token before either is spent, so a refusal
      // by the org costs the key nothing.
      if (principal) {
        const now = performance.now();
        const wait = Math.max(
          keyRate.wait(principal.keyId, now),
          orgRate.wait(principal.orgId, now),
        );
        if (wait > 0) {
          const id = (parsed as { id?: unknown } | null)?.id;
          reply({
            jsonrpc: '2.0',
            id: typeof id === 'string' || typeof id === 'number' ? id : null,
            error: {
              code: RATE_LIMITED,
              message: 'Rate limit exceeded',
              data: { retryAfterMs: wait },
            },
          });
          refusal(rpcMethod(parsed), 'rate_limited', t0, { ...requestFields, code: RATE_LIMITED });
          return;
        }
        keyRate.take(principal.keyId);
        orgRate.take(principal.orgId);
      }
      // Charged above, then dropped without a reply, as before.
      if (unparseable) {
        refusal('unknown', 'client_error', t0, { ...requestFields, code: -32700 });
        return;
      }

      // Valid JSON is not necessarily a request: `null`, `1`, `[]` and `"x"`
      // all parse. Reading `.id` off `null` used to throw here, outside every
      // try, and the rejected listener took the whole process — and every
      // session in it — down (#330). Batches are not supported, so `[]` is
      // rejected the same way.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        refusal('unknown', 'client_error', t0, { ...requestFields, code: -32600 });
        return;
      }
      const req = parsed as JsonRpcRequest;

      const res: JsonRpcResponse = { jsonrpc: '2.0', id: req.id };
      let refused = false;

      try {
        switch (req.method) {
          case 'executeCommand': {
            const parsed = ExecuteCommandParams.safeParse(req.params);
            if (!parsed.success) {
              res.error = { code: -32602, message: 'Invalid params' };
              break;
            }
            res.result = translateSync(parsed.data.instruction);
            break;
          }

          case 'launchBrowser': {
            const parsedOptions = LaunchBrowserOptions.safeParse(req.params?.options ?? {});
            if (!parsedOptions.success) {
              res.error = { code: -32602, message: 'Invalid params' };
              break;
            }
            const launchOptions = clampLaunchOptions(parsedOptions.data, limits);
            // A missing browser is a setup fault, so report it HERE rather than
            // letting it surface later as the failure of whatever action runs
            // first (issue #194). Cheap on purpose — a path resolve and a stat,
            // no process spawned — because this call must stay fast and the
            // browser is still started lazily below.
            //
            // Before the gate, so a rejected launch has NO side effects: an
            // existing session survives rather than being torn down to make room
            // for a replacement that was never going to be created. Deleting the
            // browser binary does not kill an already-running Chromium, so that
            // session stays usable, and the inactivity sweeper still reclaims it.
            if (!chromiumIsInstalled()) {
              res.error = {
                code: -32000,
                message:
                  'Playwright browsers are not installed. Run: npx playwright install chromium',
              };
              break;
            }

            // Exclusive: cleanup + create + map-write must be indivisible, or a
            // second pipelined launch interleaves at one of those awaits and
            // orphans an executor (issue #128).
            res.result = await gate.write(async () => {
              // Tear down any existing session first so its Chromium process
              // isn't orphaned when the map entry is overwritten (issue #69).
              await cleanupSession(ws, sessions, 'replaced');
              // This callback can resume after the socket closed: it waits on
              // in-flight actions and on the old session's teardown. Its 'close'
              // cleanup has then already run, so a session set now would hold a
              // maxSessions slot until the idle sweep.
              if (ws.readyState !== WebSocket.OPEN) {
                throw { code: -32000, message: 'Connection closed during launch', refused: true };
              }
              // Check and insert with no await between them: the map is shared
              // by every connection, and each connection has its own gate.
              // This connection's own session was cleaned up above, so a relaunch
              // is never counted against its org.
              // The plan's limit, never above the operator's ceiling (#346).
              const orgCap = Math.min(
                limits.maxSessionsPerOrg,
                principal?.maxSessions ?? Number.POSITIVE_INFINITY,
              );
              if (
                principal &&
                [...sessions.values()].filter((s) => s.principal?.orgId === principal.orgId)
                  .length >= orgCap
              ) {
                throw {
                  code: -32000,
                  message: orgCap
                    ? `Organization session limit reached (${orgCap}); try again later`
                    : "The organization's plan allows no browser sessions",
                  refused: true,
                };
              }
              if (sessions.size >= limits.maxSessions) {
                throw {
                  code: -32000,
                  message: `Session limit reached (${limits.maxSessions}); try again later`,
                  refused: true,
                };
              }
              const session = createBrowserSession(
                launchOptions,
                principal,
                principal && meterMinutes(principal),
              );
              sessions.set(ws, session);
              log('info', 'session started', { sessionId: session.id, ...who(principal) });
              return {
                success: true,
                // Says what happened. This used to claim "Browser launched
                // successfully" while createBrowserSession returns page: null and
                // starts nothing — a statement about the world that was untrue
                // when sent, and the reason a container healthcheck built on this
                // RPC reported a browser-less container as healthy (issue #194).
                //
                // The deferral itself is kept: a client that calls this and never
                // acts should not be holding a Chromium.
                message: 'Session created; browser starts on the first action',
                sessionId: getSessionId(ws),
                // What the session will actually use, after clamping.
                options: {
                  timeout: launchOptions.timeout,
                  retryAttempts: launchOptions.retryAttempts,
                  retryDelay: launchOptions.retryDelay,
                  slowMo: launchOptions.browserOptions.slowMo,
                },
              };
            });
            break;
          }

          case 'closeBrowser': {
            res.result = await gate.write(async () => {
              // Read the session inside the gate: a launch queued ahead of this
              // one may have replaced it since the message arrived.
              const session = sessions.get(ws);
              if (!session) {
                throw { code: -32000, message: 'No active browser session', refused: true };
              }
              await cleanupSession(ws, sessions, 'closed');
              return { success: true, message: 'Browser closed successfully' };
            });
            break;
          }

          case 'getBrowserStatus': {
            res.result = await gate.read(async () => getBrowserSessionStatus(sessions.get(ws)));
            break;
          }

          case 'executeBrowserAction': {
            const parsed = ActionParams.safeParse(req.params);
            if (!parsed.success) {
              res.error = { code: -32602, message: 'Invalid params' };
              break;
            }
            const { instruction, actions, url } = parsed.data;
            const startedAt = new Date();

            // Shared: actions still run concurrently with each other, but never
            // alongside a session mutation. Resolving the session inside the
            // callback is the point — reading it before waiting would hand this
            // action an executor a queued launch is about to destroy (#128).
            res.result = await gate.read(async () => {
              const session = sessions.get(ws);
              if (!session) {
                throw {
                  code: -32000,
                  message: 'No active browser session. Call launchBrowser first.',
                  refused: true,
                };
              }
              return executeBrowserActions(
                session,
                instruction,
                actions,
                url,
                limits.maxActionsPerRequest,
                { aiCredentials: options?.aiCredentials, usage: options?.usage },
              );
            });
            if (principal && options?.history) {
              // A side effect of the request, like local history (#77): a failed
              // write is logged, and the caller still gets the actions' result.
              await options.history
                .forOrg({ orgId: principal.orgId, apiKeyId: principal.keyId })
                .record({
                  kind: 'rpc',
                  success: res.result.success,
                  results: res.result.results,
                  startedAt,
                  finishedAt: new Date(),
                })
                .catch((err: unknown) =>
                  log('error', 'failed to record run history', {
                    ...requestFields,
                    err: errMessage(err),
                  }),
                );
            }
            break;
          }

          case 'getStatus': {
            // Real state, not a constant. `status` stays 'ready' because
            // answering at all means the server is serving — the fields beside
            // it are what make that claim checkable (issue #80).
            res.result = {
              status: 'ready',
              uptimeMs: Date.now() - startedAt,
              // A tenant sees its own org's sessions only: another org's activity
              // is not its business (#341).
              activeSessions: principal
                ? [...sessions.values()].filter((s) => s.principal?.orgId === principal.orgId)
                    .length
                : sessions.size,
              // Server-wide vs. this connection: a client asking "do I have a
              // browser?" was previously indistinguishable from "is anything alive?"
              hasSession: sessions.has(ws),
            };
            break;
          }

          // `streamLogs` is deliberately absent and falls through to -32601.
          // It used to answer a hardcoded ['log1','log2'] — fabricated data a
          // client cannot tell from real logs. Real streaming would mean a log
          // buffer and a subscription mechanism, and this server is frozen
          // legacy-experimental (docs/integration-surfaces.md), so that is the
          // wrong place to build one. An honest "method not found" is the fix
          // that decision calls for (issue #80).

          default:
            throw { code: -32601, message: 'Method not found' };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (thrown: any) {
        // `throw null` (or any primitive) must not make this catch block throw
        // in turn — that escapes the listener exactly like the frame crash (#330).
        const err = typeof thrown === 'object' && thrown !== null ? thrown : {};
        // A refusal the client caused (no session, a session limit): not a server error.
        refused = err.refused === true;
        res.error = {
          code: err.code || -32000,
          message: err.message || 'Server error',
          data: err.data,
        };
      }

      reply(res);
      // executeBrowserAction: the action types that ran, never their selectors or values.
      const ran = (res.result as { results?: ExecutionResult[] } | undefined)?.results;
      const outcome = refused
        ? 'client_error'
        : ((res.result && resultOutcome.get(res.result)) ?? rpcOutcome(res.error?.code));
      observeRequest(
        'rpc',
        rpcMethod(req),
        outcome,
        t0,
        {
          ...requestFields,
          ...(res.error && { code: res.error.code }),
          ...(Array.isArray(ran) && {
            actions: ran.map((r) => r.action?.type),
            success: res.result.success,
          }),
        },
        !closed,
      );
    });

    ws.on('close', () => {
      tenants.delete(ws);
      if (suppressed > 0 && !closed) {
        log('info', 'rpc refusals suppressed', { ...who(principal), suppressed });
      }
      cleanupSession(ws, sessions, 'disconnect');
    });

    ws.on('error', () => {
      cleanupSession(ws, sessions, 'socket_error');
    });
  });

  server.listen(port, host);
  // ws does not close a listener it was handed. Stop listening the moment close() is
  // called (REST must not keep queuing jobs during shutdown), and call back once both
  // ws (its clients gone) and the listener (its connections gone) have closed.
  const closeWss = wss.close.bind(wss) as (cb?: (err?: Error) => void) => WebSocketServer;
  wss.close = ((cb?: (err?: Error) => void) => {
    let pending = 2;
    let firstError: Error | undefined;
    const done = (err?: Error) => {
      firstError ??= err;
      if (--pending === 0) cb?.(firstError);
    };
    server.close(() => done());
    server.closeAllConnections();
    return closeWss(done);
  }) as typeof wss.close;

  wss.on('close', () => {
    clearInterval(cleanupInterval);
    clearInterval(heartbeat);
    clearInterval(recheck);
    clearInterval(checkpoint);
    // Cleanup all sessions
    for (const [ws] of sessions.entries()) {
      cleanupSession(ws, sessions, 'shutdown');
    }
    // After the shutdown's own lines: a request that finishes later is not logged (its
    // server is gone, and in a test the run may be too).
    closed = true;
  });

  return wss;
}

/**
 * Per-connection ordering gate for handlers that touch the browser session.
 *
 * Message handlers are async, so a handler that suspends at an `await` leaves a
 * gap the next pipelined message runs in. Two interleavings mattered (#128):
 * concurrent `launchBrowser` calls both passing cleanup and both writing to the
 * session map — orphaning the loser's Chromium — and a `launchBrowser` tearing
 * down the executor beneath an action still using it.
 *
 * This is a reader/writer lock rather than a plain queue, because pipelined
 * `executeBrowserAction` concurrency is deliberate and tested. Writers
 * (session-mutating handlers) run exclusively; readers run concurrently with
 * each other but never alongside a writer.
 *
 * Both methods capture what they must wait for *synchronously*, before their
 * first await, so ordering follows message arrival order rather than the order
 * the event loop happens to resume things.
 */
class SessionGate {
  private writeChain: Promise<unknown> = Promise.resolve();
  private readers = new Set<Promise<unknown>>();

  /** Run exclusively: after earlier writers, and after every in-flight reader. */
  write<T>(fn: () => Promise<T>): Promise<T> {
    const earlierWrites = this.writeChain;
    const readersInFlight = [...this.readers];
    const run = (async () => {
      await earlierWrites.catch(() => undefined);
      // allSettled, not all: a failed action must not block the teardown that
      // follows it, and its rejection is already reported to its own caller.
      await Promise.allSettled(readersInFlight);
      return fn();
    })();
    // Swallow here only to keep the chain usable; `run` still rejects for the caller.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /** Run shared: after any pending writer, but concurrently with other readers. */
  read<T>(fn: () => Promise<T>): Promise<T> {
    const pendingWrites = this.writeChain;
    const run = (async () => {
      await pendingWrites.catch(() => undefined);
      return fn();
    })();
    this.readers.add(run);
    run.catch(() => undefined).finally(() => this.readers.delete(run));
    return run;
  }
}

/**
 * Clamp wire launch options to the server's limits (#338). Omitted timings are
 * filled from the executor defaults first, so a default above an operator's
 * lower ceiling is clamped too.
 */
function clampLaunchOptions(
  options: z.infer<typeof LaunchBrowserOptions>,
  limits: ServerLimits,
): ActionExecutorOptions & {
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  browserOptions: { slowMo: number };
} {
  return {
    ...options,
    timeout: Math.min(options.timeout ?? EXECUTOR_DEFAULTS.timeout, limits.maxTimeoutMs),
    retryAttempts: Math.min(
      options.retryAttempts ?? EXECUTOR_DEFAULTS.retryAttempts,
      limits.maxRetryAttempts,
    ),
    retryDelay: Math.min(
      options.retryDelay ?? EXECUTOR_DEFAULTS.retryDelay,
      limits.maxRetryDelayMs,
    ),
    browserOptions: {
      ...options.browserOptions,
      headless: true,
      slowMo: Math.min(options.browserOptions?.slowMo ?? 0, limits.maxSlowMoMs),
    },
  };
}

/**
 * Create a new browser session with ActionExecutor. Synchronous so the session
 * cap's check-then-insert has no await in it.
 */
function createBrowserSession(
  browserOptions?: ActionExecutorOptions,
  principal?: Principal,
  onEnd?: (session: BrowserSession) => void,
): BrowserSession {
  const executor = new ActionExecutor(browserOptions);

  const session: BrowserSession = {
    executor,
    page: null,
    pageCreationPromise: null,
    isActive: true,
    lastActivity: Date.now(),
    busy: 0,
    principal,
    id: randomUUID(),
    billedSegments: 0,
    onEnd,
  };

  return session;
}

/**
 * Execute browser actions using the session's ActionExecutor
 */
async function executeBrowserActions(
  session: BrowserSession,
  instruction: string | undefined,
  actions: Action[] | undefined,
  url: string | undefined,
  maxActions: number,
  tenant: {
    aiCredentials?: (principal: Principal) => Promise<TenantCredentials | null>;
    usage?: { record(orgId: string, events: UsageEvent[]): Promise<void> };
  } = {},
): Promise<{
  success: boolean;
  results: ExecutionResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  translationResult?: any;
  error?: string;
}> {
  // Busy for the whole request, not just its start: a long action used to be
  // swept mid-flight once it outlasted the idle timeout (#240).
  session.busy++;
  session.lastActivity = Date.now();
  try {
    let actionsToExecute: Action[] = [];
    let translationResult = null;

    // If instruction provided, translate it to actions
    if (instruction) {
      // A tenant's AI translation is charged to, and gated by, its org's budget
      // (#255), and runs on its own credentials, never the operator's (#258).
      const principal = session.principal;
      // Whose account a billed call is on, from the credential the resolver gave (#479).
      let billingMode = 'byok' as 'byok' | 'managed';
      const translation = await translate(
        instruction,
        url ? { url } : undefined,
        principal
          ? {
              orgId: principal.orgId,
              // Lazy: asked only if patterns do not match. A failed lookup is no AI
              // for this request; its message stays in the server log, not the reply.
              // Each billed call goes to the usage ledger, on the org's own key (#263).
              onUsage: (call: SettledAICall) => {
                const kind = usageKindOf(call.operation);
                // Spend as a metric (#275): no org label; the ledger has the per-org split.
                aiSpend.inc(
                  { provider: call.provider, kind, billing_mode: billingMode },
                  call.costUsd,
                );
                return tenant.usage?.record(principal.orgId, [
                  {
                    kind,
                    quantity: 1,
                    unitCostUsd: call.costUsd,
                    estimated: call.estimated,
                    billingMode,
                    idempotencyKey: `${call.operation}:${call.callId}`,
                  },
                ]);
              },
              credentials: async () => {
                if (!tenant.aiCredentials) return null;
                try {
                  const resolved = await tenant.aiCredentials(principal);
                  if (resolved) billingMode = resolved.billingMode;
                  return resolved;
                } catch (err) {
                  log('error', 'AI credentials lookup failed; translating without AI', {
                    ...who(principal),
                    err: errMessage(err),
                  });
                  return null;
                }
              },
            }
          : {},
      );
      // On IRIS's managed key, a translation with no actions is a failure whose reason
      // (provider error, invalid reply) describes IRIS's vendor account: a key's last
      // characters, quota (#479). Logged, not returned. Matched by outcome, not by message
      // prefix: each client words its failures differently.
      if (billingMode === 'managed' && translation.actions.length === 0) {
        log('error', 'managed AI translation failed', {
          ...(principal && who(principal)),
          err: translation.reasoning,
        });
        translation.reasoning = 'AI translation is unavailable right now';
      }
      translationResult = translation;
      actionsToExecute = translation.actions;
    } else if (actions) {
      // Use provided actions directly
      actionsToExecute = actions;
    } else {
      return tagged(
        { success: false, results: [], error: 'Either instruction or actions must be provided' },
        'client_error',
      );
    }

    if (actionsToExecute.length === 0) {
      return {
        success: false,
        results: [],
        translationResult,
        error: 'No actions to execute',
      };
    }

    // The schema caps a wire `actions` array; this is the only place that sees
    // what an instruction translated to, and an AI translation has no bound of
    // its own (#338). Checked before the page exists, so a refusal starts no browser.
    if (actionsToExecute.length > maxActions) {
      return {
        success: false,
        results: [],
        translationResult,
        error: `Instruction translated to ${actionsToExecute.length} actions; the limit is ${maxActions}`,
      };
    }

    // The socket may have closed while this action was translating, and its
    // cleanup has then already run. A page created now would launch a Chromium
    // that nothing reclaims.
    if (!session.isActive) {
      return { success: false, results: [], translationResult, error: 'Session closed' };
    }

    // Create page if needed. Concurrent first actions share one in-flight
    // createPage() via the cached promise instead of each creating a page
    // (check-then-act race, issue #69). The promise is cleared once settled so
    // a failed creation can be retried.
    // The page dies with a crashed browser, or on its own window.close(). Drop
    // it, and createPage() relaunches if the browser went too (#240).
    if (session.page?.isClosed()) session.page = null;
    if (!session.page) {
      if (!session.pageCreationPromise) {
        session.pageCreationPromise = session.executor.createPage().finally(() => {
          session.pageCreationPromise = null;
        });
      }
      session.page = await session.pageCreationPromise;
      session.billedUntil ??= Date.now();
      // Closed while the browser was starting: cleanup found no browser to
      // close yet, so close the one that just arrived.
      if (!session.isActive) {
        await session.executor.cleanup();
        return { success: false, results: [], translationResult, error: 'Session closed' };
      }
    }

    // Execute the actions
    const results = await session.executor.executeActions(actionsToExecute, session.page);

    const success = results.every((result) => result.success);

    return {
      success,
      results,
      translationResult,
      error: success ? undefined : 'Some actions failed',
    };
  } catch (error) {
    // Tenant-caused failures returned above; what throws is ours: a launch, a page, a
    // browser that died mid-action, a translation that threw.
    return tagged(
      {
        success: false,
        results: [],
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'error',
    );
  } finally {
    session.busy--;
    session.lastActivity = Date.now();
  }
}

/**
 * Get browser session status
 */
async function getBrowserSessionStatus(session?: BrowserSession): Promise<BrowserStatus> {
  if (!session) {
    return {
      isActive: false,
      hasPage: false,
      lastActivity: 0,
    };
  }

  const status: BrowserStatus = {
    isActive: session.isActive,
    hasPage: session.page !== null && !session.page.isClosed(),
    lastActivity: session.lastActivity,
  };

  // Get page context if available
  if (session.page) {
    try {
      const context = await session.executor.getPageContext(session.page);
      status.context = {
        url: context.url,
        title: context.title,
      };
    } catch {
      // Context retrieval failed, but status is still valid
    }
  }

  return status;
}

/**
 * The usage kind of a billed AI call (#263). Explicit, so a new operation is an error
 * (logged by the reporter) rather than billed as the wrong kind.
 */
export function usageKindOf(operation: SettledAICall['operation']): UsageEvent['kind'] {
  switch (operation) {
    case 'text':
      return 'text_call';
    case 'agent_turn':
      return 'agent_turn';
    case 'vision-analysis':
      return 'vision_call';
    default:
      throw new Error(`No usage kind for AI operation ${String(operation)}`);
  }
}

/**
 * Clean up a browser session
 */
async function cleanupSession(
  ws: WebSocket,
  sessions: Map<WebSocket, BrowserSession>,
  reason:
    'replaced' | 'closed' | 'timeout' | 'revoked' | 'disconnect' | 'socket_error' | 'shutdown',
): Promise<void> {
  const session = sessions.get(ws);
  if (session) {
    // The first cleanup ends the session; a second (close after error) does not.
    if (session.isActive) {
      log('info', 'session ended', {
        sessionId: session.id,
        reason,
        browserStarted: session.billedUntil !== undefined || session.page !== null,
        ...who(session.principal),
      });
      session.onEnd?.(session);
    }
    // Before the await: an action already holding this session checks the flag
    // before it creates a page, and must see it at once.
    session.isActive = false;
    try {
      await session.executor.cleanup();
    } catch {
      // Ignore cleanup errors
    }
    // Only our own entry: a launch may have replaced it during the await, and
    // deleting that would drop a live session from the map and from the cap.
    if (sessions.get(ws) === session) sessions.delete(ws);
  }
}

/**
 * Constant-time check of an `Authorization: Bearer <token>` header against the
 * expected token. Length is compared first (timingSafeEqual throws on unequal
 * lengths); the token length is not secret, so this leaks nothing useful.
 */
function hasValidToken(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }
  const provided = Buffer.from(authHeader.slice('Bearer '.length));
  const want = Buffer.from(expected);
  return provided.length === want.length && timingSafeEqual(provided, want);
}

/**
 * Generate a session ID for a WebSocket connection
 */
function getSessionId(_ws: WebSocket): string {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Process-wide error policy for the long-running RPC server (#330).
 *
 * - **Unhandled rejection: log and keep serving.** Rejections here come from
 *   per-request async work, so one bad request must not end every other
 *   client's session. Node's default (crash) turned a single malformed frame
 *   into a full outage.
 * - **Uncaught exception: log and exit 1.** A synchronous throw that escaped
 *   every handler leaves shared state unknown, and continuing would be
 *   silently serving from it. Playwright kills the browsers it launched when
 *   the process exits, so no Chromium is orphaned.
 *
 * `proc` and `log` are injectable so the policy is testable without touching
 * the real process's handlers.
 */
export function installProcessErrorPolicy(
  proc: NodeJS.Process = process,
  report: (message: string, err: unknown) => void = (message, err) =>
    log('error', message, {
      err: errMessage(err),
      ...(err instanceof Error && { stack: err.stack }),
    }),
): void {
  proc.on('unhandledRejection', (reason) => {
    report('unhandled rejection (contained; server keeps running)', reason);
  });
  proc.on('uncaughtException', (err) => {
    report('uncaught exception; exiting because server state is unknown', err);
    proc.exit(1);
  });
}
