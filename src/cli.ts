#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';
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
    'Let --agent leave the starting origin (off by default: an agent that wanders onto another authenticated site is the risk)',
    false,
  )
  .option(
    '--allow-destructive',
    'Let --agent act on targets that read as destructive (delete, remove, reset, …)',
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
            urlPolicy: { pinnedOrigin },
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
          const dbPath = process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');

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

program
  .command('connect')
  .description('Start JSON-RPC/WebSocket server on the given port')
  .argument(
    '[port]',
    'Port to listen on (1-65535)',
    (v) => parseIntOption(v, { min: 1, max: 65535, name: 'port' }),
    4000,
  )
  .action(async (port: number) => {
    const { startServer } = await import('./protocol');
    const { randomBytes } = await import('crypto');

    // Per-session token. The server binds to 127.0.0.1 (loopback only) and now
    // also requires this token in an `Authorization: Bearer` header — a browser
    // page cannot set that header, so cross-site WebSocket hijacking and other
    // origin-less local processes are locked out. Clients read the token below.
    const authToken = randomBytes(32).toString('hex');
    const wss = startServer(port, { authToken });
    // Print the real bind address: startServer binds 127.0.0.1 (IPv4 only), so
    // advertising `localhost` would send dual-stack clients to ::1 and miss the
    // listener — making the new auth handshake look broken.
    console.log(`JSON-RPC server listening on ws://127.0.0.1:${port}`);
    console.log(`Auth token (send as "Authorization: Bearer <token>"):\n  ${authToken}`);

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
} {
  const config = loadConfig();
  const requested = providerFlag ?? detectProvider(config);
  const provider: AIProvider = requested === 'anthropic' ? 'claude' : (requested as AIProvider);

  // Every credential the environment/config offers, so the smart client's
  // fallback chain can step to another vendor rather than skipping it (#74).
  // This is additive to the primary key resolved below and never overrides it.
  const credentials = config.ai.credentials;

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
    };
  }

  const configProvider = provider === 'openai' ? 'openai' : 'anthropic';
  const apiKey =
    config.ai.provider === configProvider && config.ai.apiKey
      ? config.ai.apiKey
      : process.env[semanticKeyEnvVar(provider)];

  return { provider, apiKey, credentials };
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
  .option('--exclude <selectors>', 'CSS selectors to exclude (comma-separated)')
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
          antiAliasing: true,
          regions: [],
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

      const duration = Date.now() - startTime;
      console.log(`\n📊 Visual testing completed in ${duration}ms`);
      console.log(`   Total comparisons: ${result.summary.totalComparisons}`);
      console.log(`   Passed: ${result.summary.passed}`);
      console.log(`   Failed: ${result.summary.failed}`);

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
          exclude: [],
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
        reporting: {
          includePassedTests: false,
          groupByImpact: true,
          includeScreenshots: true,
        },
        output: {
          format: options.format,
          path: options.output,
        },
        baseURL: options.baseUrl || process.env.IRIS_BASE_URL,
      });

      const result = await runner.run();

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
