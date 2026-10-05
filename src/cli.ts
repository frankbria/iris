#!/usr/bin/env node
import { Command } from 'commander';
import { resolveDbPath } from './data-dir';
import { once } from 'events';
import { loadDotenv, loadConfig } from './config';
import type { IrisConfig, ProviderCredentials } from './config';
import { parseIntOption, parseFloatOption, parseEnumOption } from './utils/cli-options';
import type { AIProvider } from './visual/ai-classifier';
import type { TranslationResult } from './translator';
import { describeAction } from './actions';

const program = new Command();
program.name('iris').description('Interface Recognition & Interaction Suite').version('0.0.1');

program
  .command('run <instruction>')
  .description('Run a natural language instruction')
  .option('--dry-run', 'Only translate without executing actions')
  .option('--headless', 'Run browser in headless mode (default: true)')
  // Declared alongside --headless rather than replacing it. A lone boolean flag
  // can only ever yield `true` or `undefined`, so the `=== false` branches that
  // open a visible browser with devtools were unreachable (issue #78). Keeping
  // --headless declared first preserves it as an accepted no-op, so command
  // lines already passing it still work.
  .option('--no-headless', 'Run browser visibly with devtools open, for debugging')
  .option('--url <url>', 'Starting page URL (or set IRIS_BASE_URL)')
  .option('--json', 'Emit a single machine-readable JSON result on stdout', false)
  .option(
    '--agent',
    'Experimental: plan against the live page and re-plan each turn, instead of translating once up front. Requires --url.',
    false,
  )
  .option(
    '--max-turns <n>',
    'Max observe→act cycles in --agent mode',
    (v) => parseIntOption(v, { min: 1, max: 50, name: 'max-turns' }),
    8,
  )
  .option(
    '--allow <types>',
    'Restrict --agent to these action types (comma-separated: click,fill,navigate,assert)',
    (v) =>
      v.split(',').map((t) => parseEnumOption(t, ['click', 'fill', 'navigate', 'assert'], 'allow')),
  )
  .option(
    '--allow-cross-origin',
    'Let --agent leave the starting origin, and load cross-origin assets (off by default: an agent that wanders onto another authenticated site, or a page that beacons a filled-in value out through an image URL, is the risk)',
    false,
  )
  .option(
    '--allow-destructive',
    'Let --agent act on targets that read as destructive (delete, remove, reset, …)',
    false,
  )
  .option(
    '--block-private-hosts',
    'Refuse loopback, private and reserved hosts (always on under IRIS_HOSTED=1)',
    false,
  )
  .option(
    '--timeout <ms>',
    'Timeout for actions in milliseconds',
    (v) => parseIntOption(v, { min: 1000, max: 3600000, name: 'timeout' }),
    30000,
  )
  .action(
    async (
      instruction: string,
      options: {
        dryRun?: boolean;
        headless?: boolean;
        timeout?: number;
        url?: string;
        json?: boolean;
        agent?: boolean;
        maxTurns?: number;
        allow?: Array<'click' | 'fill' | 'navigate' | 'assert'>;
        allowCrossOrigin?: boolean;
        allowDestructive?: boolean;
        blockPrivateHosts?: boolean;
      },
    ) => {
      const startTime = new Date();
      let status: 'success' | 'error' = 'success';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const executionResults: any[] = [];
      const startUrl = options.url || process.env.IRIS_BASE_URL;

      // In JSON mode stdout is a machine contract, so narration is suppressed
      // entirely — an assistant pipes this straight into JSON.parse. Errors keep
      // going to console.error (stderr), which never pollutes the payload.
      const say = (message: string) => {
        if (!options.json) console.log(message);
      };

      // Captured for the JSON envelope, which is emitted once from `finally` so
      // that every exit path (success, no-actions return, throw, dry-run) reports.
      let translation: TranslationResult | null = null;
      let executed = false;
      // null = the plan contained no assertions, i.e. no goal was stated.
      let goalMet: boolean | null = null;
      // Populated only in --agent mode; stays null so the one-shot envelope is unchanged.
      let agent: { turns: number; terminationReason: string } | null = null;

      /**
       * Executor options shared by the one-shot and agent paths, so the two
       * cannot drift apart on timeout or retry behaviour.
       */
      const executorOptions = {
        timeout: options.timeout ?? 30000,
        trackContext: true,
        retryAttempts: 2,
        retryDelay: 1000,
        browserOptions: {
          headless: options.headless !== false,
          devtools: options.headless === false, // Enable devtools in non-headless mode
        },
        urlPolicy: { blockPrivateHosts: options.blockPrivateHosts },
      };

      try {
        if (options.agent) {
          // Both guards run before any browser launch: a usage error should cost
          // nothing and surface immediately. They go to stderr rather than say()
          // so they are still visible when --json owns stdout.
          if (!startUrl) {
            console.error(
              '❌ --agent needs a starting page: pass --url <url> or set IRIS_BASE_URL.\n' +
                '   The loop plans against what is actually on the page, so it cannot start from about:blank.',
            );
            status = 'error';
            return;
          }
          if (options.dryRun) {
            console.error(
              '❌ --agent cannot be combined with --dry-run.\n' +
                '   Each turn is planned from the result of the last one, so there is nothing to translate without executing.',
            );
            status = 'error';
            return;
          }

          executed = true;
          const { ActionExecutor } = await import('./executor');
          const { originOf } = await import('./agent-policy');

          // Pin at the REQUEST layer, not just before each action. A pre-action
          // check notices a same-origin click that navigates away only on the
          // next turn, by which time the cross-origin request has gone out.
          const pinnedOrigin = options.allowCrossOrigin
            ? undefined
            : (originOf(startUrl) ?? undefined);
          const executor = new ActionExecutor({
            ...executorOptions,
            urlPolicy: { ...executorOptions.urlPolicy, pinnedOrigin },
          });

          try {
            await executor.launchBrowser();
            const page = await executor.createPage();

            say(`🤖 Agent mode (experimental), up to ${options.maxTurns ?? 8} turns`);
            say(
              `   Policy: ${options.allow ? options.allow.join('/') : 'all actions'}, ` +
                `${options.allowCrossOrigin ? 'any origin' : 'start origin only'}, ` +
                `${options.allowDestructive ? 'destructive allowed' : 'destructive refused'}`,
            );
            say(`   Opening starting page: ${startUrl}`);

            // Routed through executeAction so the URL policy applies, exactly as
            // the one-shot path does.
            const navResult = await executor.executeAction(
              { type: 'navigate', url: startUrl },
              page,
            );
            executionResults.push(navResult);

            if (!navResult.success) {
              say(`   ❌ Failed to open starting page: ${navResult.error}`);
              status = 'error';
            } else {
              const { runAgentLoop } = await import('./agent-loop');
              const outcome = await runAgentLoop({
                instruction,
                executor,
                page,
                maxTurns: options.maxTurns ?? 8,
                // What the user asked for, not where the navigation landed: a
                // start URL that redirects cross-origin must not silently move
                // the origin the agent is pinned to.
                startUrl,
                log: (message) => say(`   ${message}`),
                policy: {
                  allow: options.allow,
                  pinOrigin: !options.allowCrossOrigin,
                  allowDestructive: options.allowDestructive,
                },
              });

              executionResults.push(...outcome.results);
              goalMet = outcome.goalMet;
              agent = { turns: outcome.turns, terminationReason: outcome.terminationReason };

              // A failed action is NOT a failed agent run — recovering from one is
              // the entire point of re-planning, so the one-shot path's "every
              // action succeeded" rule would be wrong here. The verdict is whether
              // the goal held at the end.
              //
              // Not `terminationReason === 'goal_met'` either: a model that keeps
              // acting alongside its assert never trips the completion signal, so a
              // run can end at the turn cap with the goal demonstrably passing.
              // Reporting that as a failure contradicts the "Goal check: passed"
              // printed a line earlier — observed with a small local model.
              //
              // Abnormal exits stay errors regardless, since `goalMet` there can be
              // a stale verdict from a turn before things went wrong.
              const abnormalExit =
                outcome.terminationReason === 'error' ||
                outcome.terminationReason === 'consecutive_failures';
              if (goalMet !== true || abnormalExit) {
                status = 'error';
              }

              say(
                `\n🎯 Agent finished after ${outcome.turns} turn(s): ${outcome.terminationReason}`,
              );
              if (goalMet === null) {
                say('   Goal unverified — the model never asserted anything.');
              } else {
                say(`   Goal check: ${goalMet ? 'passed' : 'failed'}`);
              }
            }

            await executor.cleanup();
          } catch (agentError) {
            status = 'error';
            console.error(
              '\n❌ Agent run failed:',
              agentError instanceof Error ? agentError.message : agentError,
            );
            try {
              await executor.cleanup();
            } catch (cleanupError) {
              console.error(
                'Warning: Browser cleanup failed:',
                cleanupError instanceof Error ? cleanupError.message : cleanupError,
              );
            }
          }
          return;
        }

        const { translate } = await import('./translator');
        const result = await translate(instruction, startUrl ? { url: startUrl } : undefined);
        translation = result;

        say(`✨ Translation result (${result.method}):`);
        say(`   Actions: ${JSON.stringify(result.actions)}`);
        say(`   Confidence: ${result.confidence}`);
        if (result.reasoning) {
          say(`   Reasoning: ${result.reasoning}`);
        }

        if (result.actions.length === 0) {
          status = 'error';
          say('⚠️  No actions generated from instruction');
          return;
        }

        // Execute actions unless dry-run
        if (!options.dryRun) {
          executed = true;
          say('\n🚀 Executing actions...');

          const { ActionExecutor } = await import('./executor');
          const executor = new ActionExecutor(executorOptions);

          try {
            // Launch browser and create page
            await executor.launchBrowser();
            const page = await executor.createPage();

            // Provide feedback about browser mode
            if (options.headless !== false) {
              say('   Running in headless mode...');
            } else {
              say('   Launching visible browser with developer tools...');
            }

            // Open the starting page first, otherwise every non-navigate action
            // runs against about:blank (issue #112). Routed through executeAction
            // so the URL policy applies to the user-supplied URL. Skipped when the
            // instruction already begins with a navigation, to avoid loading twice.
            let startPageReady = true;
            if (startUrl && result.actions[0].type !== 'navigate') {
              say(`   Opening starting page: ${startUrl}`);
              const navResult = await executor.executeAction(
                { type: 'navigate', url: startUrl },
                page,
              );
              executionResults.push(navResult);

              if (!navResult.success) {
                say(`   ❌ Failed to open starting page: ${navResult.error}`);
                status = 'error';
                startPageReady = false;
              }
            }

            // Execute each action and report progress
            for (let i = 0; startPageReady && i < result.actions.length; i++) {
              const action = result.actions[i];
              say(`   [${i + 1}/${result.actions.length}] Executing: ${describeAction(action)}`);

              const execResult = await executor.executeAction(action, page);
              executionResults.push(execResult);

              if (execResult.success) {
                say(`   ✅ Success (${execResult.duration}ms)`);
                if (execResult.context?.url) {
                  say(`      Current page: ${execResult.context.url}`);
                }
              } else {
                say(`   ❌ Failed: ${execResult.error}`);
                status = 'error';
                // Continue with remaining actions instead of stopping
              }
            }

            // Goal verdict: did every assertion in the plan hold? Distinct from
            // per-action success, which only says the Playwright call didn't
            // throw. Stays null when the plan asserted nothing, so "no goal
            // stated" is never conflated with "goal met".
            const assertResults = executionResults.filter((r) => r.action?.type === 'assert');
            if (assertResults.length > 0) {
              goalMet = assertResults.every((r) => r.success);
              say(`\n🎯 Goal check: ${goalMet ? 'passed' : 'failed'}`);
              for (const failed of assertResults.filter((r) => !r.success)) {
                say(`   ✗ ${failed.action.description ?? describeAction(failed.action)}`);
              }
            }

            // Final status
            const successCount = executionResults.filter((r) => r.success).length;
            const totalCount = executionResults.length;

            if (successCount === totalCount) {
              say(`\n🎉 All ${totalCount} actions completed successfully!`);
            } else {
              say(`\n⚠️  ${successCount}/${totalCount} actions completed successfully`);
              status = 'error';
            }

            // Clean up browser resources
            await executor.cleanup();
          } catch (executionError) {
            status = 'error';
            console.error(
              '\n❌ Execution failed:',
              executionError instanceof Error ? executionError.message : executionError,
            );

            // Ensure cleanup even on error
            try {
              await executor.cleanup();
            } catch (cleanupError) {
              // Ignore cleanup errors, but log them for debugging
              console.error(
                'Warning: Browser cleanup failed:',
                cleanupError instanceof Error ? cleanupError.message : cleanupError,
              );
            }
          }
        } else {
          say('\n🔍 Dry run mode - actions not executed');
        }
      } catch (error) {
        status = 'error';
        console.error('Error processing instruction:', error);
      } finally {
        const endTime = new Date();

        // Persist to database (graceful degradation: never crash the run on a DB hiccup)
        try {
          const { initializeDatabase, insertTestRun } = await import('./db');
          const dbPath = resolveDbPath();

          // initializeDatabase creates the parent dir (mode 0o700) if needed.
          const db = initializeDatabase(dbPath);
          try {
            insertTestRun(db, {
              instruction,
              status,
              startTime,
              endTime,
            });
          } finally {
            // Always close, even if insertTestRun throws, so the handle never leaks.
            db.close();
          }
        } catch (dbErr) {
          console.error(
            '⚠️  Failed to persist run to database:',
            dbErr instanceof Error ? dbErr.message : dbErr,
          );
        }

        // The machine-readable envelope. Emitted last and from `finally` so it
        // covers every exit path, and built field-by-field rather than spreading
        // internal objects — this shape is a public contract for assistants, and
        // future changes to it must be additive.
        if (options.json) {
          console.log(
            JSON.stringify({
              instruction,
              translation: translation && {
                method: translation.method,
                confidence: translation.confidence,
                reasoning: translation.reasoning ?? null,
                actions: translation.actions,
              },
              executed,
              goalMet,
              // null outside --agent mode, so the one-shot contract is unchanged.
              agent,
              results: executionResults.map((r) => ({
                success: r.success,
                action: r.action ?? null,
                error: r.error ?? null,
                duration: r.duration ?? null,
                context: r.context ?? null,
              })),
              status,
            }),
          );
        }
      }
    },
  );

program
  .command('watch [target]')
  .description('Watch files or directories and trigger runs on changes')
  .option('-i, --instruction <instruction>', 'Instruction to run when files change', 'click submit')
  .option('--execute', 'Enable browser execution (default: translation only)')
  .option('--headless', 'Run browser in headless mode (default: true when executing)')
  .option('--quiet', 'Suppress per-change narration; errors still print', false)
  .option(
    '--block-private-hosts',
    'Refuse loopback, private and reserved hosts (always on under IRIS_HOSTED=1)',
    false,
  )
  // Same unreachable-branch fix as `run` — see the note there (issue #78).
  .option('--no-headless', 'Run browser visibly with devtools open, for debugging')
  .option(
    '--browser-timeout <ms>',
    'Browser operation timeout in milliseconds',
    (v) => parseIntOption(v, { min: 1000, max: 3600000, name: 'browserTimeout' }),
    30000,
  )
  .option(
    '--retry-attempts <n>',
    'Number of retry attempts for failed actions',
    (v) => parseIntOption(v, { min: 0, max: 10, name: 'retryAttempts' }),
    2,
  )
  .option(
    '--retry-delay <ms>',
    'Delay between retry attempts in milliseconds',
    (v) => parseIntOption(v, { min: 0, max: 60000, name: 'retryDelay' }),
    1000,
  )
  .option(
    '--feedback',
    'On each change, capture the page and report what changed visually instead of replaying --instruction',
    false,
  )
  .option(
    '--feedback-url <url>',
    'Page to observe in --feedback mode (or set IRIS_BASE_URL). Defaults to the changed file itself.',
  )
  .option(
    '--provider <name>',
    'AI provider for --feedback (openai|anthropic|ollama). Default: auto-detect from environment',
    (v) => parseEnumOption(v, ['openai', 'anthropic', 'ollama'], 'provider'),
  )
  .option(
    '--max-ai-calls <n>',
    'Session cap on AI calls in --feedback mode',
    (v) => parseIntOption(v, { min: 1, max: 10000, name: 'max-ai-calls' }),
    50,
  )
  .action(
    async (
      target: string | undefined,
      options: {
        instruction: string;
        execute?: boolean;
        quiet?: boolean;
        blockPrivateHosts?: boolean;
        headless?: boolean;
        browserTimeout?: number;
        retryAttempts?: number;
        retryDelay?: number;
        feedback?: boolean;
        feedbackUrl?: string;
        provider?: string;
        maxAiCalls?: number;
      },
    ) => {
      // Resolved before the watcher starts: a missing key is a usage error the
      // user can act on, not something to discover on the first file save.
      let ai;
      if (options.feedback) {
        ai = resolveSemanticAI(options.provider);
        if (ai.provider !== 'ollama' && !ai.apiKey) {
          console.error(
            `\n❌ --feedback requires an API key: set ${semanticKeyEnvVar(ai.provider)}, ` +
              'or use --provider ollama to analyze locally.',
          );
          process.exit(2); // Invalid usage
        }
      }

      try {
        const { watchFiles } = await import('./watcher');
        await watchFiles(target, options.instruction, {
          execute: options.execute,
          quiet: options.quiet,
          blockPrivateHosts: options.blockPrivateHosts,
          headless: options.headless,
          browserTimeout: options.browserTimeout,
          retryAttempts: options.retryAttempts,
          retryDelay: options.retryDelay,
          feedback: options.feedback,
          feedbackUrl: options.feedbackUrl,
          maxAiCalls: options.maxAiCalls,
          ai,
        });
      } catch (error) {
        console.error('Watch error:', error);
        process.exit(1);
      }
    },
  );

/** `iris connect` options; the `max*` ones are server limits (#338). */
interface ConnectOptions {
  host?: string;
  maxPayload?: number;
  maxConnections?: number;
  maxSessions?: number;
  maxActions?: number;
  ratePerKey?: number;
  ratePerOrg?: number;
  maxSessionsPerOrg?: number;
  maxConnectionsPerOrg?: number;
  metricsPort?: number;
}

/** `--metrics-port` (#275): Prometheus metrics on 127.0.0.1 only, off unless given. */
const METRICS_PORT_HELP =
  'Serve Prometheus metrics at http://127.0.0.1:<port>/metrics (default off)';
const parseMetricsPort = (v: string) =>
  parseIntOption(v, { min: 1, max: 65535, name: 'metrics-port' });

/** Starts the metrics listener, or exits 3 (environment error) when it cannot bind. */
async function startMetrics(port: number | undefined): Promise<boolean> {
  if (port === undefined) return true;
  const { serveMetrics } = await import('./metrics');
  try {
    await serveMetrics(port);
    return true;
  } catch (err) {
    console.error(`Cannot serve metrics on 127.0.0.1:${port}: ${(err as Error).message}`);
    process.exit(3); // Environment/runtime error
    return false;
  }
}

program
  .command('connect')
  .description('Start JSON-RPC/WebSocket server on the given port')
  .argument(
    '[port]',
    'Port to listen on (1-65535)',
    (v) => parseIntOption(v, { min: 1, max: 65535, name: 'port' }),
    4000,
  )
  .option(
    '--host <address>',
    'Address to bind (default 127.0.0.1; also IRIS_CONNECT_HOST). ' +
      'Only widen this behind a trusted boundary — see the warning below',
  )
  // Server resource limits (#338); an omitted flag keeps DEFAULT_SERVER_LIMITS.
  .option('--max-payload <bytes>', 'Largest accepted frame (default 1 MiB)', (v) =>
    parseIntOption(v, { min: 1024, max: 100 * 1024 * 1024, name: 'max-payload' }),
  )
  .option('--max-connections <n>', 'Open sockets (default 16)', (v) =>
    parseIntOption(v, { min: 1, max: 10_000, name: 'max-connections' }),
  )
  .option('--max-sessions <n>', 'Browser sessions server-wide (default 4)', (v) =>
    parseIntOption(v, { min: 1, max: 1000, name: 'max-sessions' }),
  )
  .option('--max-actions <n>', 'Actions per executeBrowserAction request (default 100)', (v) =>
    parseIntOption(v, { min: 1, max: 10_000, name: 'max-actions' }),
  )
  // Tenant limits (#342): hosted mode only, where each connection has an API key.
  .option('--rate-per-key <n>', 'Hosted: requests per minute per API key (default 120)', (v) =>
    parseIntOption(v, { min: 1, max: 1_000_000, name: 'rate-per-key' }),
  )
  .option('--rate-per-org <n>', 'Hosted: requests per minute per org (default 300)', (v) =>
    parseIntOption(v, { min: 1, max: 1_000_000, name: 'rate-per-org' }),
  )
  .option('--max-sessions-per-org <n>', 'Hosted: browser sessions per org (default 2)', (v) =>
    parseIntOption(v, { min: 1, max: 1000, name: 'max-sessions-per-org' }),
  )
  .option('--max-connections-per-org <n>', 'Hosted: connections per org (default 8)', (v) =>
    parseIntOption(v, { min: 1, max: 10_000, name: 'max-connections-per-org' }),
  )
  .option('--metrics-port <port>', METRICS_PORT_HELP, parseMetricsPort)
  .action(async (port: number, options: ConnectOptions) => {
    const { startServer, installProcessErrorPolicy } = await import('./protocol');
    const { randomBytes } = await import('crypto');
    const { readFile } = await import('fs/promises');

    // Bind address, most explicit first. The default stays loopback: this server
    // drives a real browser, so a wider bind turns it into an SSRF engine that
    // anything routable can reach (see src/url-policy.ts for why that matters).
    //
    // It is configurable at all because a container cannot use loopback: Docker
    // forwards a published port to the container's network interface, so a
    // 127.0.0.1 bind means the service starts, looks healthy, and refuses every
    // connection (issue #192). Widen it only where something else — a published
    // port scoped to 127.0.0.1, a private network — provides the boundary.
    // `||`, not `??`: an empty value means "unset", and `??` would keep `''`,
    // which WebSocketServer treats as "bind every interface" — silently widening
    // the boundary for an operator whose wrapper script wrote
    // `export IRIS_CONNECT_HOST=` meaning the opposite. Same trap as #185's
    // IRIS_DOTENV_DIR.
    const host = options.host || process.env.IRIS_CONNECT_HOST || '127.0.0.1';

    // A supplied token is used verbatim so a deployed instance keeps a stable
    // credential across restarts; without one, a fresh per-session token is
    // generated exactly as before. Either way the server requires it in an
    // `Authorization: Bearer` header — a browser page cannot set that header, so
    // cross-site WebSocket hijacking and origin-less local processes are locked out.
    //
    // IRIS_CONNECT_TOKEN_FILE is the deployed form (#332): an env var shows up in
    // `docker inspect` and /proc/<pid>/environ, a mounted secret file does not.
    const tokenFile = process.env.IRIS_CONNECT_TOKEN_FILE;
    const { isHostedMode } = await import('./hosted');
    // Hosted mode (#341, ADR 0001 §4): tenants authenticate with their org's API
    // keys, and the shared token is off. A token set anyway is refused rather than
    // ignored: whoever set it expects it to be what guards the server.
    let authenticate: import('./protocol').Authenticator | undefined;
    let history: import('./history-store').PostgresHistory | undefined;
    let usage: ReturnType<typeof import('./billing/usage').usageLedger> | undefined;
    let jobs: import('./history-store').PostgresJobs | undefined;
    let artifacts: import('./artifact-store').ArtifactStore | null = null;
    let aiCredentials:
      | ((
          p: import('./protocol').Principal,
        ) => Promise<import('./ai-client/credentials').AICredentials | null>)
      | undefined;
    if (isHostedMode()) {
      if (tokenFile || process.env.IRIS_CONNECT_TOKEN) {
        console.error(
          'Hosted mode authenticates API keys; unset IRIS_CONNECT_TOKEN and IRIS_CONNECT_TOKEN_FILE',
        );
        process.exit(2); // Invalid usage
        return;
      }
      try {
        const { hostedServices } = await import('./api-key-auth');
        ({ authenticate, history, aiCredentials, usage, jobs } = await hostedServices());
        // Signs run-detail artifacts (#460); unset IRIS_S3_ENDPOINT means none.
        artifacts = (await import('./artifact-store')).resolveArtifactStore();
      } catch (err) {
        console.error(`Cannot start in hosted mode: ${(err as Error).message}`);
        process.exit(3); // Environment/runtime error
        return;
      }
    }
    if (tokenFile && process.env.IRIS_CONNECT_TOKEN) {
      console.error('Set IRIS_CONNECT_TOKEN and IRIS_CONNECT_TOKEN_FILE one at a time, not both');
      process.exit(2); // Invalid usage
      return;
    }
    let suppliedToken = process.env.IRIS_CONNECT_TOKEN;
    if (tokenFile) {
      // An unreadable or empty file must not fall through to a random token: that
      // server would look healthy and refuse every client holding the real one.
      try {
        suppliedToken = (await readFile(tokenFile, 'utf8')).trim();
      } catch (err) {
        console.error(`Cannot read IRIS_CONNECT_TOKEN_FILE: ${(err as Error).message}`);
        process.exit(3); // Environment/runtime error
        return;
      }
      if (!suppliedToken) {
        console.error(`IRIS_CONNECT_TOKEN_FILE (${tokenFile}) holds no token`);
        process.exit(3); // Environment/runtime error
        return;
      }
    }
    const authToken = authenticate ? undefined : suppliedToken || randomBytes(32).toString('hex');

    const limits = Object.fromEntries(
      Object.entries({
        maxPayloadBytes: options.maxPayload,
        maxConnections: options.maxConnections,
        maxSessions: options.maxSessions,
        maxActionsPerRequest: options.maxActions,
        keyRequestsPerMinute: options.ratePerKey,
        orgRequestsPerMinute: options.ratePerOrg,
        maxSessionsPerOrg: options.maxSessionsPerOrg,
        maxConnectionsPerOrg: options.maxConnectionsPerOrg,
      }).filter(([, v]) => v !== undefined),
    );

    const wss = startServer(
      port,
      authenticate
        ? {
            host,
            authenticate,
            history,
            runs: history,
            artifacts: artifacts ?? undefined,
            aiCredentials,
            usage,
            jobs,
            limits,
          }
        : { host, authToken, limits },
    );
    // Wait for the bind before claiming it. `listen` fails asynchronously, so
    // logging straight after startServer() announced a server that then died
    // on an unhandled 'error' event when the port was taken (#330). `once`
    // rejects on 'error', which is the bind failure.
    try {
      await once(wss, 'listening');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const reason = e.code === 'EADDRINUSE' ? 'address already in use' : e.message;
      console.error(`Cannot listen on ${host}:${port}: ${reason}`);
      wss.close();
      process.exit(3); // Environment/runtime error
      return;
    }
    if (!(await startMetrics(options.metricsPort))) {
      wss.close();
      return;
    }
    installProcessErrorPolicy();
    // Advertise the address actually bound. Hardcoding 127.0.0.1 here would
    // describe a container as unreachable while it works fine, and advertising
    // `localhost` would send dual-stack clients to ::1 and miss an IPv4 listener.
    console.log(`JSON-RPC server listening on ws://${host}:${port}`);
    // Only echo a token this process invented. Reprinting a supplied one tells
    // the operator what they already know and copies a secret into the logs.
    if (authToken && !suppliedToken) {
      console.log(`Auth token (send as "Authorization: Bearer <token>"):\n  ${authToken}`);
    }

    // Close the server on Ctrl+C / termination so wss.on('close') drains
    // in-flight sessions (executor.cleanup) instead of being skipped. Existing
    // client sockets must be closed first — wss.close() only stops accepting new
    // connections and won't fire 'close' (or let the process exit) while a
    // client stays connected. Installing this handler also suppresses Node's
    // default SIGINT/SIGTERM termination, so without this the process would hang.
    const shutdown = () => {
      console.log('\nShutting down JSON-RPC server...');
      for (const client of wss?.clients ?? []) {
        client.close(1001, 'Server shutting down');
      }
      wss?.close();
      // Force-terminate if a wedged/unresponsive client stalls the graceful
      // close handshake; otherwise wss never emits 'close' and the process hangs.
      // unref() so this timer never keeps the process alive on its own.
      setTimeout(() => {
        for (const client of wss?.clients ?? []) {
          client.terminate();
        }
        process.exit(0);
      }, 5000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('worker')
  .description('Run hosted jobs from the queue (hosted mode only, #267)')
  .option('--poll-ms <ms>', 'Wait between polls of an empty queue', (v) =>
    parseIntOption(v, { min: 100, max: 60_000, name: 'poll-ms' }),
  )
  .option('--metrics-port <port>', METRICS_PORT_HELP, parseMetricsPort)
  .action(async (options: { pollMs?: number; metricsPort?: number }) => {
    const { isHostedMode } = await import('./hosted');
    // Jobs scan tenant-supplied URLs: without the hosted URL policy and egress proxy
    // that is an SSRF engine, so a worker outside hosted mode refuses to start.
    if (!isHostedMode()) {
      console.error('iris worker runs in hosted mode only: set IRIS_HOSTED=1');
      process.exit(2); // Invalid usage
      return;
    }
    const { createPostgresDb, probeDatabase, resolveDatabaseUrl } = await import('./db/postgres');
    const { postgresJobs } = await import('./history-store');
    const { runWorker } = await import('./worker');
    let db: ReturnType<typeof createPostgresDb> | undefined;
    let artifacts: import('./artifact-store').ArtifactStore | null = null;
    try {
      // Visual jobs (#268) need somewhere to put images; without IRIS_S3_* the worker
      // runs a11y jobs only (and the API refuses visual ones). Partial config: exit 3.
      artifacts = (await import('./artifact-store')).resolveArtifactStore();
      db = createPostgresDb(resolveDatabaseUrl(), { queryTimeoutMs: 5_000 });
      // Like hosted connect: a worker that cannot reach its queue must not look started.
      await probeDatabase(db);
    } catch (err) {
      console.error(`Cannot start the worker: ${(err as Error).message}`);
      await db?.destroy();
      process.exit(3); // Environment/runtime error
      return;
    }
    if (!(await startMetrics(options.metricsPort))) {
      await db.destroy();
      return;
    }
    // SIGTERM stops the loop after the current job; a second signal ends it now.
    const stop = new AbortController();
    const onSignal = () => {
      if (stop.signal.aborted) process.exit(1);
      console.log('Stopping after the current job...');
      stop.abort();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    console.log(`iris worker: waiting for jobs (${artifacts ? 'a11y, visual' : 'a11y only'})`);
    try {
      await runWorker({
        jobs: postgresJobs(db),
        signal: stop.signal,
        pollMs: options.pollMs,
        // Compose's liveness check reads its age (#273).
        heartbeatFile: process.env.IRIS_WORKER_HEARTBEAT_FILE || undefined,
        artifacts: artifacts ?? undefined,
      });
    } finally {
      await db.destroy();
    }
  });

/**
 * Operator commands (#348), run on the box against the hosted database:
 * `docker compose exec iris node dist/cli.js admin ...`. Hosted only (exit 2), the
 * database from `DATABASE_URL(_FILE)` (exit 3 when unreachable), exit 1 for an
 * unknown org. The reason is for operators: tenants are never shown it.
 */
const admin = program
  .command('admin')
  .description('Operator commands for the hosted service (hosted mode only)');

/** Opens the hosted database for one admin command, runs `fn`, and closes it. */
async function withAdminDb(
  fn: (
    suspensions: ReturnType<typeof import('./org-suspension').orgSuspensions>,
    db: import('kysely').Kysely<unknown>,
  ) => Promise<void>,
): Promise<void> {
  const { isHostedMode } = await import('./hosted');
  if (!isHostedMode()) {
    console.error('iris admin runs in hosted mode only: set IRIS_HOSTED=1');
    process.exit(2); // Invalid usage
    return;
  }
  const { createPostgresDb, probeDatabase, resolveDatabaseUrl } = await import('./db/postgres');
  const { orgSuspensions, UnknownOrgError } = await import('./org-suspension');
  const { OffboardingError } = await import('./offboarding');
  let db: ReturnType<typeof createPostgresDb> | undefined;
  try {
    db = createPostgresDb(resolveDatabaseUrl(), { queryTimeoutMs: 10_000 });
    await probeDatabase(db);
  } catch (err) {
    console.error(`Cannot open the database: ${(err as Error).message}`);
    await db?.destroy();
    process.exit(3); // Environment/runtime error
    return;
  }
  let code = 0;
  try {
    await fn(orgSuspensions(db), db);
  } catch (err) {
    console.error((err as Error).message);
    code = err instanceof UnknownOrgError || err instanceof OffboardingError ? 1 : 3;
  } finally {
    await db.destroy();
  }
  if (code) process.exit(code);
}

/** Who acts: `--actor`, else the operator's login (through sudo too), else `operator`. */
const defaultActor = () => process.env.SUDO_USER || process.env.USER || 'operator';

const formatEvent = (e: import('./org-suspension').SuspensionEvent) =>
  `${e.createdAt.toISOString()}  ${e.action.padEnd(9)}  by ${e.actor}: ${e.reason}`;

for (const action of ['suspend', 'unsuspend'] as const) {
  admin
    .command(`${action}-org <orgId>`)
    .description(
      action === 'suspend'
        ? 'Suspend an org: its keys get 403, live connections close, queued jobs fail'
        : 'Lift an org suspension',
    )
    .requiredOption('--reason <text>', 'Why (recorded; never shown to the tenant)')
    .option('--actor <name>', 'Who is acting (default: $SUDO_USER, $USER, or "operator")')
    .action(async (orgId: string, options: { reason: string; actor?: string }) => {
      const by = { reason: options.reason.trim(), actor: (options.actor ?? defaultActor()).trim() };
      if (!by.reason || !by.actor) {
        console.error('--reason and --actor must not be blank');
        process.exit(2); // Invalid usage
        return;
      }
      await withAdminDb(async (suspensions) => {
        const result = await suspensions[action](orgId, by);
        const state = result.suspended ? 'suspended' : 'active';
        console.log(
          result.changed
            ? `org ${orgId} is now ${state}`
            : `org ${orgId} is already ${state}; nothing recorded`,
        );
      });
    });
}

admin
  .command('org-status <orgId>')
  .description("Print an org's suspension state and history")
  .action(async (orgId: string) => {
    await withAdminDb(async (suspensions) => {
      const status = await suspensions.status(orgId);
      console.log(`org ${orgId}: ${status.suspended ? 'suspended' : 'active'}`);
      const history = await suspensions.history(orgId);
      if (!history.length) console.log('no suspension history');
      for (const event of history) console.log(formatEvent(event));
    });
  });

/** Offboarding and retention (#349): deletion is a 30-day soft delete, then a purge. */
admin
  .command('delete-org <orgId>')
  .description('Request deletion: suspended now, purged after 30 days unless restored')
  .requiredOption('--reason <text>', 'Why (recorded for operators)')
  .option('--actor <name>', 'Who is acting (default: $SUDO_USER, $USER, or "operator")')
  .action(async (orgId: string, options: { reason: string; actor?: string }) => {
    const by = { reason: options.reason.trim(), actor: (options.actor ?? defaultActor()).trim() };
    if (!by.reason || !by.actor) {
      console.error('--reason and --actor must not be blank');
      process.exit(2); // Invalid usage
      return;
    }
    await withAdminDb(async (_s, db) => {
      const { offboarding } = await import('./offboarding');
      const purgeAfter = await offboarding(db).requestOrgDeletion(orgId, by);
      console.log(
        `org ${orgId} is suspended; its data is purged after ${purgeAfter.toISOString()}`,
      );
    });
  });

admin
  .command('restore-org <orgId>')
  .description('Cancel a pending deletion (within the 30 days) and lift its suspension')
  .option('--actor <name>', 'Who is acting (default: $SUDO_USER, $USER, or "operator")')
  .action(async (orgId: string, options: { actor?: string }) => {
    await withAdminDb(async (_s, db) => {
      const { offboarding } = await import('./offboarding');
      await offboarding(db).restoreOrg(orgId, { actor: (options.actor ?? defaultActor()).trim() });
      console.log(`deletion of org ${orgId} cancelled`);
    });
  });

admin
  .command('delete-user <userId>')
  .description('Delete a user account; terms evidence is kept pseudonymised for 7 years')
  .action(async (userId: string) => {
    await withAdminDb(async (_s, db) => {
      const { offboarding } = await import('./offboarding');
      await offboarding(db).deleteUser(userId);
      console.log(`user ${userId} deleted`);
    });
  });

admin
  .command('retention')
  .description(
    'Daily pass: purge orgs past their grace period, old runs, expired sessions and tokens, ' +
      "expired records, and this container's AI ledger/cache rows of purged orgs",
  )
  .action(async () => {
    await withAdminDb(async (_s, db) => {
      const { offboarding, purgeOrgAiState } = await import('./offboarding');
      const { resolveDataDir } = await import('./data-dir');
      const off = offboarding(db);
      const report = await off.runRetention();
      const { join } = await import('path');
      const ai = purgeOrgAiState(await off.purgedOrgIds(), join(resolveDataDir(), 'cache'));
      console.log(
        JSON.stringify({ ...report, aiLedgerRows: ai.ledgerRows, aiCacheRows: ai.cacheRows }),
      );
      // A failed step is logged and the rest still ran; exit 3 so the timer alerts.
      if (report.failures.length)
        throw new Error(`retention steps failed: ${report.failures.join(', ')}`);
    });
  });

/** Documented default port for a local Ollama daemon. */
const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * Resolve the AI provider and credentials for `visual-diff --semantic`.
 *
 * `--provider` wins; otherwise the provider is auto-detected by `loadConfig()`
 * (`~/.iris/config.json`, then `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
 * `OLLAMA_ENDPOINT`). The key is always chosen to match the *resolved* provider,
 * so `--provider anthropic` can never pick up an exported `OPENAI_API_KEY`.
 *
 * Note the vocabulary shift: config uses `anthropic`, the classifier uses `claude`.
 */
function resolveSemanticAI(providerFlag?: string): {
  provider: AIProvider;
  apiKey?: string;
  endpoint?: string;
  credentials?: ProviderCredentials;
  fallback?: boolean;
} {
  const config = loadConfig();
  const requested = providerFlag ?? detectProvider(config);
  const provider: AIProvider = requested === 'anthropic' ? 'claude' : (requested as AIProvider);

  // Every credential the environment/config offers, so the smart client's
  // fallback chain can step to another vendor rather than skipping it (#74).
  // This is additive to the primary key resolved below and never overrides it.
  const credentials = config.ai.credentials;
  // Other vendors are called only when the config opts in (#245).
  const fallback = config.ai.fallback;

  // Ollama runs locally: no key, but it needs an endpoint or it throws at call
  // time. Only honor a configured endpoint when it was configured *for* ollama —
  // otherwise `--provider ollama` on a machine whose config points at, say, an
  // OpenAI-compatible proxy would aim the ollama client at that proxy.
  if (provider === 'ollama') {
    const configuredEndpoint = config.ai.provider === 'ollama' ? config.ai.endpoint : undefined;
    return {
      provider,
      endpoint: configuredEndpoint || process.env.OLLAMA_ENDPOINT || DEFAULT_OLLAMA_ENDPOINT,
      credentials,
      fallback,
    };
  }

  const configProvider = provider === 'openai' ? 'openai' : 'anthropic';
  const apiKey =
    config.ai.provider === configProvider && config.ai.apiKey
      ? config.ai.apiKey
      : process.env[semanticKeyEnvVar(provider)];

  return { provider, apiKey, credentials, fallback };
}

/** Environment variable that supplies the key for a paid vision provider. */
function semanticKeyEnvVar(provider: AIProvider): string {
  return provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
}

/**
 * Pick the provider to use when `--provider` was not passed.
 *
 * `loadConfig()` only consults the environment when `~/.iris/config.json` is
 * absent, and its fallback provider is `openai` with no key. So a user who has
 * ever run `iris` with a config file, and exports only `ANTHROPIC_API_KEY`, would
 * otherwise be told to "set OPENAI_API_KEY". When the configured provider carries
 * no usable credential, believe the environment instead.
 */
function detectProvider(config: IrisConfig): IrisConfig['ai']['provider'] {
  const configured = config.ai.provider;
  if (configured === 'ollama' || config.ai.apiKey) {
    return configured;
  }
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OLLAMA_ENDPOINT) return 'ollama';
  return configured;
}

program
  .command('visual-diff')
  .description('Run visual regression testing')
  .option('--pages <patterns>', 'Page patterns to test (comma-separated)', '/')
  .option('--baseline <reference>', 'Baseline branch or commit', 'main')
  .option(
    '--baseline-strategy <strategy>',
    'How to interpret --baseline (branch|commit|tag)',
    (v) => parseEnumOption(v, ['branch', 'commit', 'tag'], 'baseline-strategy'),
    'branch',
  )
  .option(
    '--semantic',
    'Enable AI-powered semantic analysis (provider auto-detected from environment; see --provider)',
    false,
  )
  .option(
    '--provider <name>',
    'AI provider for --semantic (openai|anthropic|ollama). Default: auto-detect from environment',
    (v) => parseEnumOption(v, ['openai', 'anthropic', 'ollama'], 'provider'),
  )
  .option(
    '--threshold <value>',
    'Max fraction of pixels allowed to differ, 0-1 (default 0.1 = 10%)',
    (v) => parseFloatOption(v, { min: 0, max: 1, name: 'threshold' }),
    0.1,
  )
  .option('--devices <list>', 'Device types (desktop,mobile,tablet)', 'desktop')
  .option('--format <type>', 'Output format (html|json|junit)', 'html')
  .option('--output <path>', 'Output file path')
  .option(
    '--fail-on <severity>',
    'Fail on severity level (minor|moderate|breaking)',
    (v) => parseEnumOption(v, ['breaking', 'moderate', 'minor'], 'fail-on'),
    'breaking',
  )
  .option('--update-baseline', 'Update baseline with current screenshots', false)
  .option('--mask <selectors>', 'CSS selectors to mask (comma-separated)')
  .option(
    '--concurrency <number>',
    'Max concurrent comparisons',
    (v) => parseIntOption(v, { min: 1, max: 32, name: 'concurrency' }),
    3,
  )
  .option(
    '--base-url <url>',
    'Origin for relative --pages patterns (or set IRIS_BASE_URL). Defaults to http://localhost:3000',
  )
  .option('--show-cost', 'Print a read-only AI cost/cache summary after the run', false)
  .action(async (options) => {
    const startTime = Date.now();

    // Resolve AI credentials up front, before any browser work: a missing key is
    // a usage error the user can act on, not a constructor throw surfacing as an
    // opaque runtime failure mid-run (issue #111).
    const ai = options.semantic ? resolveSemanticAI(options.provider) : undefined;
    if (ai && ai.provider !== 'ollama' && !ai.apiKey) {
      console.error(
        `\n❌ --semantic requires an API key: set ${semanticKeyEnvVar(ai.provider)}, or use --provider ollama to analyze locally.`,
      );
      process.exit(2); // Invalid usage
    }

    try {
      console.log('🎯 Starting visual regression testing...');

      const { VisualTestRunner } = await import('./visual/visual-runner');

      const runner = new VisualTestRunner({
        pages: options.pages.split(',').map((p: string) => p.trim()),
        baseline: {
          strategy: options.baselineStrategy,
          reference: options.baseline,
        },
        capture: {
          viewport: { width: 1920, height: 1080 },
          fullPage: true,
          mask: options.mask ? options.mask.split(',').map((s: string) => s.trim()) : [],
          format: 'png' as const,
          quality: 90,
          stabilization: {
            waitForFonts: true,
            disableAnimations: true,
            delay: 500,
            waitForNetworkIdle: true,
            networkIdleTimeout: 2000,
          },
        },
        diff: {
          threshold: options.threshold,
          semanticAnalysis: options.semantic,
          aiProvider: ai?.provider ?? 'openai',
          apiKey: ai?.apiKey,
          aiEndpoint: ai?.endpoint,
          aiCredentials: ai?.credentials,
          aiFallback: ai?.fallback,
          antiAliasing: true,
          maxConcurrency: options.concurrency,
        },
        devices: options.devices.split(',').map((d: string) => d.trim()),
        updateBaseline: options.updateBaseline,
        failOn: options.failOn,
        baseURL: options.baseUrl || process.env.IRIS_BASE_URL,
        output: {
          format: options.format,
          path: options.output,
        },
      });

      const result = await runner.run();

      // Record the run before any exit path below — the failure branches call
      // process.exit(), so persisting later would only ever capture passes.
      const { recordVisualRun } = await import('./history');
      recordVisualRun(result, new Date(startTime), new Date());

      const duration = Date.now() - startTime;
      console.log(`\n📊 Visual testing completed in ${duration}ms`);
      console.log(`   Total comparisons: ${result.summary.totalComparisons}`);
      console.log(`   Passed: ${result.summary.passed}`);
      console.log(`   Failed: ${result.summary.failed}`);
      if (result.runId)
        console.log(`   Run: ${result.runId} (artifacts in .iris/runs/${result.runId}/)`);

      // Read-only AI cost summary (spike 008). Only printed when opted in and a
      // classifier ran; cost is $0 on all-cache-hit or local/stub-provider runs.
      if (options.showCost && result.costSummary) {
        const c = result.costSummary;
        console.log(
          `   AI vision: ${c.operationCount} analyses, est. $${c.totalCost.toFixed(4)} (cache hit rate ${(c.cacheHitRate * 100).toFixed(1)}%)`,
        );
      }

      if (result.summary.overallStatus === 'failed') {
        console.log(`\n❌ Visual regression detected!`);
        console.log(`   Breaking: ${result.summary.severityCounts.breaking || 0}`);
        console.log(`   Moderate: ${result.summary.severityCounts.moderate || 0}`);
        console.log(`   Minor: ${result.summary.severityCounts.minor || 0}`);

        if (options.format === 'html' && result.reportPath) {
          console.log(`\n📋 Report generated: ${result.reportPath}`);
        }

        // Exit with failure code based on severity threshold
        const failureSeverities = ['breaking', 'moderate', 'minor'];
        const failIndex = failureSeverities.indexOf(options.failOn);
        // Defense-in-depth: the parser normally rejects bad values, but if an
        // unrecognized severity ever reaches here, fail loudly rather than let
        // slice(0, 0) swallow the regression and exit 0.
        if (failIndex === -1) {
          console.error(
            `\n❌ Invalid --fail-on value "${options.failOn}"; expected one of breaking|moderate|minor.`,
          );
          process.exit(2); // Invalid usage
        }
        const hasFailures = failureSeverities
          .slice(0, failIndex + 1)
          .some(
            (severity) =>
              (result.summary.severityCounts[
                severity as keyof typeof result.summary.severityCounts
              ] || 0) > 0,
          );

        if (hasFailures) {
          process.exit(5); // Visual regression failure exit code
        }
      } else {
        console.log(`\n✅ All visual tests passed!`);
      }
    } catch (error) {
      console.error(`\n❌ Visual testing failed:`, error);
      process.exit(3); // Environment/runtime error
    }
  });

program
  .command('a11y')
  .description('Run accessibility testing')
  .option('--pages <patterns>', 'Page patterns to test (comma-separated)', '/')
  .option('--rules <rules>', 'Specific axe rules to run (comma-separated)')
  .option('--tags <tags>', 'Axe rule tags (wcag2a,wcag2aa,wcag21aa)', 'wcag2a,wcag2aa')
  .option('--exclude <selectors>', 'CSS selectors to exclude from the scan (comma-separated)')
  .option(
    '--fail-on <impacts>',
    'Fail on impact levels (critical,serious,moderate,minor)',
    'critical,serious',
  )
  .option('--format <type>', 'Output format (html|json|junit)', 'html')
  .option('--output <path>', 'Output file path')
  .option('--include-keyboard', 'Include keyboard navigation testing', true)
  .option('--include-screenreader', 'Include screen reader simulation', false)
  .option(
    '--base-url <url>',
    'Origin for relative --pages patterns (or set IRIS_BASE_URL). Defaults to http://localhost:3000',
  )
  .action(async (options) => {
    const startTime = Date.now();

    try {
      console.log('♿ Starting accessibility testing...');

      const { AccessibilityRunner } = await import('./a11y/a11y-runner');

      const runner = new AccessibilityRunner({
        pages: options.pages.split(',').map((p: string) => p.trim()),
        axe: {
          rules: {},
          tags: options.tags.split(',').map((t: string) => t.trim()),
          // --rules means "run only these rules", which is axe's runOnly. Feeding
          // them to `rules` instead would merely toggle them and still scan
          // everything — the silent-widening bug this wiring fixes (issue #72).
          runOnlyRules: options.rules
            ? options.rules
                .split(',')
                .map((r: string) => r.trim())
                .filter(Boolean)
            : undefined,
          include: [],
          // AxeRunner has always applied these (axe-integration.ts), but this was
          // hardcoded `[]`, so there was no way to reach it — the matching flag
          // lived on `iris visual`, where nothing consumed it (issue #77).
          exclude: options.exclude
            ? options.exclude
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean)
            : [],
          disableRules: [],
          timeout: 30000,
        },
        keyboard: {
          testFocusOrder: options.includeKeyboard,
          testTrapDetection: options.includeKeyboard,
          testArrowKeyNavigation: options.includeKeyboard,
          testEscapeHandling: options.includeKeyboard,
          customSequences: [],
        },
        screenReader: {
          testAriaLabels: options.includeScreenreader,
          testLandmarkNavigation: options.includeScreenreader,
          testImageAltText: options.includeScreenreader,
          testHeadingStructure: options.includeScreenreader,
          simulateScreenReader: options.includeScreenreader,
        },
        failureThreshold: options.failOn
          .split(',')
          .reduce((acc: Record<string, boolean>, impact: string) => {
            acc[impact.trim()] = true;
            return acc;
          }, {}),
        output: {
          format: options.format,
          path: options.output,
        },
        baseURL: options.baseUrl || process.env.IRIS_BASE_URL,
      });

      const result = await runner.run();

      // Before the exit paths below, for the same reason as the visual command.
      const { recordA11yRun } = await import('./history');
      recordA11yRun(result, new Date(startTime), new Date());

      const duration = Date.now() - startTime;
      console.log(`\n📊 Accessibility testing completed in ${duration}ms`);
      console.log(`   Total violations: ${result.summary.totalViolations}`);
      console.log(`   Accessibility score: ${result.summary.score}/100`);

      if (!result.summary.passed) {
        console.log(`\n❌ Accessibility violations found!`);
        console.log(`   Critical: ${result.summary.violationsBySeverity.critical || 0}`);
        console.log(`   Serious: ${result.summary.violationsBySeverity.serious || 0}`);
        console.log(`   Moderate: ${result.summary.violationsBySeverity.moderate || 0}`);
        console.log(`   Minor: ${result.summary.violationsBySeverity.minor || 0}`);

        if (options.format === 'html' && result.reportPath) {
          console.log(`\n📋 Report generated: ${result.reportPath}`);
        }

        process.exit(4); // Accessibility failure exit code
      } else {
        console.log(`\n✅ All accessibility tests passed!`);
      }
    } catch (error) {
      console.error(`\n❌ Accessibility testing failed:`, error);
      process.exit(3); // Environment/runtime error
    }
  });

export async function runCli(args: string[]): Promise<void> {
  loadDotenv(); // pick up .env before any command reads process.env
  // `program` is a module-level singleton and commander keeps parsed option values
  // on it, so a second runCli() in the same process would inherit the previous
  // run's flags (e.g. a leftover --dry-run). Reset every option to its default.
  for (const cmd of program.commands) {
    for (const opt of cmd.options) {
      cmd.setOptionValueWithSource(opt.attributeName(), opt.defaultValue, 'default');
    }
  }
  await program.parseAsync(args, { from: 'node' });
}

if (require.main === module) {
  runCli(process.argv).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
