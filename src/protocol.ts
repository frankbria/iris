import WebSocket, { WebSocketServer } from 'ws';
import { timingSafeEqual } from 'crypto';
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
});

/**
 * Start a JSON-RPC 2.0 over WebSocket server on the given port.
 */
export function startServer(
  port: number,
  options?: {
    sessionTimeout?: number;
    host?: string;
    allowedOrigins?: string[];
    authToken?: string;
    /** Overrides for any subset of `DEFAULT_SERVER_LIMITS`. */
    limits?: Partial<ServerLimits>;
  },
): WebSocketServer {
  const host = options?.host ?? '127.0.0.1';
  const limits: ServerLimits = { ...DEFAULT_SERVER_LIMITS, ...options?.limits };
  const allowedOrigins = options?.allowedOrigins ?? [];
  const ActionParams = ExecuteBrowserActionParams.extend({
    actions: z.array(ActionSchema).max(limits.maxActionsPerRequest).optional(),
  });

  const wss: WebSocketServer = new WebSocketServer({
    port,
    host,
    maxPayload: limits.maxPayloadBytes,
    // Every check runs before the upgrade completes, so a refused client never
    // holds a socket, a message listener or a connection slot (#338). This used
    // to accept first and close with 1008 after. Synchronous on purpose: the
    // connection count read here cannot change before ws adds the new client.
    verifyClient: ({ req }, done) => {
      // Reject cross-site WebSocket hijacking: a browser page connecting to
      // localhost sends an Origin header; trusted local tooling sends none.
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) return done(false, 403, 'Origin not allowed');
      // The token travels in the Authorization header, which a browser page
      // cannot set on a WebSocket. Absent Origin is NOT treated as trusted: no
      // token means rejected.
      if (options?.authToken && !hasValidToken(req.headers.authorization, options.authToken)) {
        return done(false, 401, 'Unauthorized');
      }
      if (wss.clients.size >= limits.maxConnections) {
        return done(false, 503, 'Connection limit reached');
      }
      done(true);
    },
  });
  const sessions = new Map<WebSocket, BrowserSession>();
  const sessionTimeout = options?.sessionTimeout || 30 * 60 * 1000; // 30 minutes default
  /** Server start, so `getStatus` can report real uptime rather than a constant (issue #80). */
  const startedAt = Date.now();

  // Cleanup inactive sessions periodically
  const cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [ws, session] of sessions.entries()) {
        if (now - session.lastActivity > sessionTimeout) {
          cleanupSession(ws, sessions);
        }
      }
    },
    5 * 60 * 1000,
  ); // Check every 5 minutes
  cleanupInterval.unref();

  // Heartbeat: a half-open peer (vanished without a FIN) otherwise pins its
  // browser until the idle sweep, ~35 minutes. A peer that has not answered the
  // previous ping by the next tick is terminated, which fires 'close' and so
  // the ordinary session cleanup.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, limits.heartbeatIntervalMs);
  heartbeat.unref();

  wss.on('connection', (ws) => {
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    // One gate per connection: sessions are keyed by socket, so ordering only
    // needs to hold within a connection. Scoped to this closure so it dies with
    // the socket rather than needing its own cleanup path.
    const gate = new SessionGate();

    // A request can outlive its socket: the client may close while a handler
    // is awaiting. ws then buffers the reply for a peer that is gone instead of
    // sending it, so check first (#330).
    const reply = (res: JsonRpcResponse) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(res));
    };

    ws.on('message', async (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }

      // Valid JSON is not necessarily a request: `null`, `1`, `[]` and `"x"`
      // all parse. Reading `.id` off `null` used to throw here, outside every
      // try, and the rejected listener took the whole process — and every
      // session in it — down (#330). Batches are not supported, so `[]` is
      // rejected the same way.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
        return;
      }
      const req = parsed as JsonRpcRequest;

      const res: JsonRpcResponse = { jsonrpc: '2.0', id: req.id };

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
              await cleanupSession(ws, sessions);
              // This callback can resume after the socket closed: it waits on
              // in-flight actions and on the old session's teardown. Its 'close'
              // cleanup has then already run, so a session set now would hold a
              // maxSessions slot until the idle sweep.
              if (ws.readyState !== WebSocket.OPEN) {
                throw { code: -32000, message: 'Connection closed during launch' };
              }
              // Check and insert with no await between them: the map is shared
              // by every connection, and each connection has its own gate.
              if (sessions.size >= limits.maxSessions) {
                throw {
                  code: -32000,
                  message: `Session limit reached (${limits.maxSessions}); try again later`,
                };
              }
              sessions.set(ws, createBrowserSession(launchOptions));
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
                throw { code: -32000, message: 'No active browser session' };
              }
              await cleanupSession(ws, sessions);
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
                };
              }
              return executeBrowserActions(
                session,
                instruction,
                actions,
                url,
                limits.maxActionsPerRequest,
              );
            });
            break;
          }

          case 'getStatus': {
            // Real state, not a constant. `status` stays 'ready' because
            // answering at all means the server is serving — the fields beside
            // it are what make that claim checkable (issue #80).
            res.result = {
              status: 'ready',
              uptimeMs: Date.now() - startedAt,
              activeSessions: sessions.size,
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
        res.error = {
          code: err.code || -32000,
          message: err.message || 'Server error',
          data: err.data,
        };
      }

      reply(res);
    });

    ws.on('close', () => {
      cleanupSession(ws, sessions);
    });

    ws.on('error', () => {
      cleanupSession(ws, sessions);
    });
  });

  wss.on('close', () => {
    clearInterval(cleanupInterval);
    clearInterval(heartbeat);
    // Cleanup all sessions
    for (const [ws] of sessions.entries()) {
      cleanupSession(ws, sessions);
    }
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
function createBrowserSession(browserOptions?: ActionExecutorOptions): BrowserSession {
  const executor = new ActionExecutor(browserOptions);

  const session: BrowserSession = {
    executor,
    page: null,
    pageCreationPromise: null,
    isActive: true,
    lastActivity: Date.now(),
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
): Promise<{
  success: boolean;
  results: ExecutionResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  translationResult?: any;
  error?: string;
}> {
  try {
    session.lastActivity = Date.now();

    let actionsToExecute: Action[] = [];
    let translationResult = null;

    // If instruction provided, translate it to actions
    if (instruction) {
      const translation = await translate(instruction, url ? { url } : undefined);
      translationResult = translation;
      actionsToExecute = translation.actions;
    } else if (actions) {
      // Use provided actions directly
      actionsToExecute = actions;
    } else {
      throw new Error('Either instruction or actions must be provided');
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
    if (!session.page) {
      if (!session.pageCreationPromise) {
        session.pageCreationPromise = session.executor.createPage().finally(() => {
          session.pageCreationPromise = null;
        });
      }
      session.page = await session.pageCreationPromise;
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
    return {
      success: false,
      results: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
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
    hasPage: session.page !== null,
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
 * Clean up a browser session
 */
async function cleanupSession(
  ws: WebSocket,
  sessions: Map<WebSocket, BrowserSession>,
): Promise<void> {
  const session = sessions.get(ws);
  if (session) {
    // Before the await: an action already holding this session checks the flag
    // before it creates a page, and must see it at once.
    session.isActive = false;
    try {
      await session.executor.cleanup();
    } catch {
      // Ignore cleanup errors
    }
    sessions.delete(ws);
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
  log: (message: string, err: unknown) => void = console.error,
): void {
  proc.on('unhandledRejection', (reason) => {
    log('[iris] unhandled rejection (contained; server keeps running):', reason);
  });
  proc.on('uncaughtException', (err) => {
    log('[iris] uncaught exception; exiting because server state is unknown:', err);
    proc.exit(1);
  });
}
