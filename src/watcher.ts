import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import picomatch from 'picomatch';
import { loadConfig } from './config';
import { translate } from './translator';
import { describeAction } from './actions';
import { initializeDatabase, insertTestRun } from './db';
import { ActionExecutor, ExecutionResult, ActionExecutorOptions } from './executor';
import { navigate } from './browser';
import { Page } from 'playwright';
import { VisualCaptureEngine } from './visual/capture';
import { VisualDiffEngine } from './visual/diff';
import { AIVisualClassifier } from './visual/ai-classifier';
import type { AIProvider } from './visual/ai-classifier';
import type { ProviderCredentials } from './config';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'url';

export interface WatchOptions {
  patterns?: string[];
  ignore?: string[];
  debounceMs?: number;
  cwd?: string;
  instruction?: string;
  persistent?: boolean;
  // Browser execution options
  execute?: boolean; // Enable browser execution (default: false for translation only)
  headless?: boolean; // Browser visibility (default: true)
  browserTimeout?: number; // Browser operation timeout (default: 30000)
  retryAttempts?: number; // Retry attempts for failed actions (default: 2)
  retryDelay?: number; // Delay between retries (default: 1000)
  // AI feedback mode options
  /** Classify what changed on screen instead of replaying an instruction. */
  feedback?: boolean;
  /** Page to observe. Falls back to IRIS_BASE_URL, then the changed file itself. */
  feedbackUrl?: string;
  /** Session cap on AI calls, so a hot edit loop cannot run up a bill. */
  maxAiCalls?: number;
  /** Suppress narration and warnings on the default console logger. Errors still print. */
  quiet?: boolean;
  /** Route all output somewhere else entirely. Wins over `quiet`. */
  logger?: WatchLogger;
  /** Provider/key for the classifier, resolved by the caller (see cli.ts). */
  ai?: {
    provider: AIProvider;
    apiKey?: string;
    endpoint?: string;
    credentials?: ProviderCredentials;
  };
}

/**
 * How much of the screen must differ before a change is worth an AI call.
 *
 * The diff engine reports `passed` against this: below it the capture counts as
 * unchanged and the AI is never consulted, which is what keeps a save that
 * touched no rendered pixels free.
 */
const FEEDBACK_DIFF_THRESHOLD = 0.001;

/** Default session cap on AI calls in feedback mode. */
const DEFAULT_MAX_AI_CALLS = 50;

/**
 * Sink for the watcher's narration.
 *
 * FileWatcher is an exported class, so a consumer embedding it inherited ~59
 * unsilenceable emoji `console.*` calls straight onto their stdout (issue #81).
 * Signatures mirror `console` so call sites stay unchanged and any console-like
 * object can be passed directly.
 */
export interface WatchLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * Console-backed logger. `quiet` silences narration and warnings.
 *
 * `error` is deliberately NOT silenced: suppressing failures is not quiet, it
 * is hiding. A caller who genuinely wants total silence passes their own
 * logger, which is an explicit choice rather than a side effect of a flag.
 */
export function createConsoleLogger(quiet = false): WatchLogger {
  const noop = () => {};
  return {
    log: quiet ? noop : (...args: unknown[]) => console.log(...args),
    warn: quiet ? noop : (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  };
}

export interface WatchEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}

export class FileWatcher {
  private watcher?: FSWatcher;
  /** Compiled include matcher, built lazily and reused across events. */
  private isIncluded?: (testPath: string) => boolean;
  private debounceTimer?: NodeJS.Timeout;
  // `logger`/`quiet` are resolved into `this.logger` in the constructor, so they
  // are not part of the settled option bag.
  private options: Required<Omit<WatchOptions, 'quiet' | 'logger'>>;
  private isRunning = false;
  private executor?: ActionExecutor;
  private page?: Page;
  private browserSessionActive = false;
  private activeExecution?: Promise<void>;
  private pendingEvent?: WatchEvent;
  private initPromise?: Promise<void>;
  // Feedback mode state
  private captureEngine?: VisualCaptureEngine;
  private diffEngine?: VisualDiffEngine;
  private classifier?: AIVisualClassifier;
  /** The last capture, compared against on the next change. */
  private referenceCapture?: Buffer;
  private aiCallsUsed = 0;
  private aiCapNotified = false;
  /**
   * Public so `watchFiles` can narrate its own shutdown through the same sink
   * rather than reaching for console and defeating the caller's logger.
   */
  readonly logger: WatchLogger;

  constructor(options: WatchOptions = {}) {
    const config = loadConfig();
    // An explicit logger wins over `quiet`: passing both is a caller telling us
    // exactly where output goes, and a flag should not override that.
    this.logger = options.logger ?? createConsoleLogger(options.quiet ?? false);
    this.options = {
      patterns: options.patterns || config.watch.patterns,
      ignore: options.ignore || config.watch.ignore,
      debounceMs: options.debounceMs || config.watch.debounceMs,
      cwd: options.cwd || process.cwd(),
      instruction: options.instruction || 'click submit',
      persistent: options.persistent ?? true,
      execute: options.execute ?? false,
      headless: options.headless ?? true,
      browserTimeout: options.browserTimeout ?? 30000,
      retryAttempts: options.retryAttempts ?? 2,
      retryDelay: options.retryDelay ?? 1000,
      feedback: options.feedback ?? false,
      feedbackUrl: options.feedbackUrl ?? '',
      maxAiCalls: options.maxAiCalls ?? DEFAULT_MAX_AI_CALLS,
      ai: options.ai ?? { provider: 'openai' },
    };

    if (this.options.feedback) {
      this.captureEngine = new VisualCaptureEngine();
      this.diffEngine = new VisualDiffEngine();
    }
  }

  /**
   * The classifier, built on first use.
   *
   * Not in the constructor: building one opens a SQLite-backed vision cache, and
   * a watcher that never sees a visual change — or never sees one past the diff
   * gate — should not open a database to prove it. Constructing it eagerly also
   * made the class impossible to instantiate without a writable cache
   * directory, which is how CI found this.
   */
  private ensureClassifier(): AIVisualClassifier {
    if (!this.classifier) {
      this.classifier = new AIVisualClassifier({
        provider: this.options.ai.provider,
        apiKey: this.options.ai.apiKey,
        baseURL: this.options.ai.endpoint,
        credentials: this.options.ai.credentials,
        maxTokens: 1024,
        temperature: 0.1,
      });
    }
    return this.classifier;
  }

  /**
   * Does this path match the configured watch patterns?
   *
   * Built once per call site rather than per event — picomatch compiles the
   * glob, and recompiling it for every filesystem event on a large tree is the
   * kind of cost that only shows up under load.
   */
  private matchesPatterns(relativePath: string): boolean {
    this.isIncluded ??= picomatch(this.normalizedPatterns());
    return this.isIncluded(relativePath);
  }

  /**
   * Watch patterns as POSIX paths relative to `cwd`.
   *
   * `watch <target>` can put an absolute path in `patterns` (see watchFiles),
   * while chokidar reports paths relative to `cwd`. Comparing the two without
   * normalising would silently match nothing.
   */
  private normalizedPatterns(): string[] {
    return this.options.patterns.map((pattern) =>
      path.isAbsolute(pattern)
        ? path.relative(this.options.cwd, pattern).split(path.sep).join('/')
        : pattern,
    );
  }

  /**
   * The `ignored` predicate chokidar 5 uses in place of glob watching.
   *
   * Directories and files are treated differently on purpose. Returning true
   * for a directory stops chokidar descending into it, so a directory may only
   * be excluded by an explicit ignore pattern — filtering directories by the
   * *include* patterns would prune the whole tree and watch nothing, since
   * `src` does not match `**\/*.ts`.
   *
   * When chokidar calls without stats we fall back to ignore-patterns only. The
   * include filter is applied again in handleFileEvent, so a file admitted here
   * for lack of stats is still dropped before it triggers a run.
   */
  private buildIgnoreFilter(): (testPath: string, stats?: { isDirectory(): boolean }) => boolean {
    const isIgnored = picomatch(this.options.ignore);

    return (testPath, stats) => {
      const relative = path.relative(this.options.cwd, testPath).split(path.sep).join('/');
      // The watch root itself must never be ignored.
      if (relative === '' || relative === '.') return false;

      if (isIgnored(relative)) return true;
      if (stats && !stats.isDirectory()) return !this.matchesPatterns(relative);
      return false;
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Watcher is already running');
      return;
    }

    this.logger.log(`🔍 Starting file watcher...`);
    this.logger.log(`   Patterns: ${this.options.patterns.join(', ')}`);
    this.logger.log(`   Ignoring: ${this.options.ignore.join(', ')}`);
    this.logger.log(`   Debounce: ${this.options.debounceMs}ms`);
    this.logger.log(`   Working directory: ${this.options.cwd}`);
    this.logger.log(
      `   Mode: ${
        this.options.feedback
          ? 'AI feedback (classify visual changes)'
          : this.options.execute
            ? 'Execute actions'
            : 'Translation only'
      }`,
    );

    if (this.options.feedback) {
      this.logger.log(
        `   Observing: ${this.options.feedbackUrl || process.env.IRIS_BASE_URL || 'the changed file'}`,
      );
      this.logger.log(`   AI call cap: ${this.options.maxAiCalls}`);
      await this.captureStartupReference();
    }

    if (this.options.execute) {
      this.logger.log(`   Browser: ${this.options.headless ? 'Headless' : 'Visible'}`);
      this.logger.log(`   Timeout: ${this.options.browserTimeout}ms`);
      try {
        await this.initializeBrowserSession();
      } catch (error) {
        this.logger.error('Failed to initialize browser session:', error);
        throw error;
      }
    }

    // chokidar 4 removed glob support entirely, so the watch target is the
    // directory and all pattern matching moves into `ignored` (issue #172).
    //
    // This is the failure mode worth guarding: passing a glob to chokidar 5
    // does not throw — it watches a literal path named `**/*.{ts,...}`, which
    // does not exist, and the watcher silently never fires again.
    this.watcher = chokidarWatch(this.options.cwd, {
      ignored: this.buildIgnoreFilter(),
      cwd: this.options.cwd,
      persistent: this.options.persistent,
      ignoreInitial: true,
      followSymlinks: false,
      depth: undefined,
    });

    this.watcher
      .on('add', (filePath) => this.handleFileEvent('add', filePath))
      .on('change', (filePath) => this.handleFileEvent('change', filePath))
      .on('unlink', (filePath) => this.handleFileEvent('unlink', filePath))
      .on('error', (error) => this.logger.error('Watcher error:', error))
      .on('ready', () => {
        this.isRunning = true;
        this.logger.log('🎯 File watcher ready. Waiting for changes...');
      });
  }

  async stop(): Promise<void> {
    // isRunning only flips true on chokidar's ready event, but start() may
    // already have launched a browser and a watcher — a pre-ready stop() must
    // still tear those down, or the browser leaks.
    const hasResources =
      this.watcher !== undefined ||
      this.browserSessionActive ||
      this.initPromise !== undefined ||
      this.activeExecution !== undefined;
    if (!this.isRunning && !hasResources) {
      return;
    }

    this.logger.log('⏹️  Stopping file watcher...');

    // Mark as stopped up front: chokidar can still emit during close(), and a
    // debounce timer set then would otherwise fire after teardown and relaunch
    // a browser with no owner left to clean it up.
    this.isRunning = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }

    // Let the in-flight execution finish before tearing down the browser
    // session it is using; the coalesced follow-up is dropped, and the
    // isRunning guard in scheduleExecution blocks anything scheduled later.
    this.pendingEvent = undefined;
    if (this.activeExecution) {
      await this.activeExecution.catch(() => {});
    }

    // Clean up browser session
    await this.cleanupBrowserSession();

    // The classifier holds a SQLite-backed cache; a watcher stopped and
    // restarted in-process would otherwise accumulate open handles.
    this.classifier?.close();
    this.classifier = undefined;

    this.logger.log('✅ File watcher stopped');
  }

  private handleFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): void {
    // Authoritative include gate. `ignored` also applies it, but only when
    // chokidar supplies stats — so this is what makes the filter correct
    // regardless of when that happens. chokidar reports paths relative to cwd
    // already; normalise separators for the matcher on Windows (issue #172).
    const relative = path.isAbsolute(filePath)
      ? path.relative(this.options.cwd, filePath).split(path.sep).join('/')
      : filePath.split(path.sep).join('/');
    if (!this.matchesPatterns(relative)) {
      return;
    }

    const event: WatchEvent = {
      type,
      path: filePath,
      timestamp: new Date(),
    };

    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new debounce timer
    this.debounceTimer = setTimeout(() => {
      this.scheduleExecution(event);
    }, this.options.debounceMs);
  }

  /**
   * Serialize executions: at most one executeInstruction runs at a time.
   * Events arriving mid-run coalesce into a single follow-up run using the
   * latest event (the coalescing mirrors debounce; the follow-up itself
   * starts immediately, without another debounce delay).
   */
  private scheduleExecution(event: WatchEvent): void {
    if (!this.isRunning) {
      return;
    }

    if (this.activeExecution) {
      this.pendingEvent = event;
      return;
    }

    // The settle handler drives the coalesced follow-up run; finally (not then)
    // so the guard also clears if executeInstruction ever starts rejecting.
    this.activeExecution = this.executeInstruction(event).finally(() => {
      this.activeExecution = undefined;
      const next = this.pendingEvent;
      this.pendingEvent = undefined;
      if (next) {
        this.scheduleExecution(next);
      }
    });
  }

  /**
   * The page feedback mode observes.
   *
   * Prefers what the user named, then the session's base URL, and only then the
   * changed file itself — which is the right default for a static page being
   * edited, and useless for a dev server, hence the ordering.
   */
  private resolveFeedbackUrl(event: WatchEvent): string {
    if (this.options.feedbackUrl) {
      return this.options.feedbackUrl;
    }
    if (process.env.IRIS_BASE_URL) {
      return process.env.IRIS_BASE_URL;
    }
    // pathToFileURL escapes URL-reserved characters that plain concatenation
    // would mis-parse when handed to page.goto().
    return pathToFileURL(path.resolve(this.options.cwd, event.path)).href;
  }

  /**
   * Capture the reference before any file changes, so the first save is
   * already comparable.
   *
   * Without this the first edit after starting — the most likely thing a user
   * does — produces only "Reference captured" and no feedback at all.
   *
   * Only possible when the page is known up front. With no URL configured the
   * observed page is the changed file itself, which cannot be known before a
   * change happens, so that case still establishes the reference on first save.
   */
  private async captureStartupReference(): Promise<void> {
    const url = this.options.feedbackUrl || process.env.IRIS_BASE_URL;
    if (!url) {
      this.logger.log('   No --feedback-url set — the first change will establish the reference.');
      return;
    }

    try {
      await this.initializeBrowserSession();
      if (!this.page || !this.captureEngine) {
        throw new Error('Feedback session not initialized');
      }
      await navigate(this.page, url);
      const capture = await this.captureEngine.capture(this.page, {
        fullPage: true,
        maskSelectors: [],
        stabilizeMs: 500,
        disableAnimations: true,
        type: 'png',
      });

      if (capture.success && capture.buffer) {
        this.referenceCapture = capture.buffer;
        this.logger.log('   📸 Reference captured — your next save will be compared against it');
      } else {
        this.logger.log(
          `   ⚠️  Could not capture a reference: ${capture.error ?? 'unknown error'}`,
        );
      }
    } catch (error) {
      // Never block startup on this: the first change re-establishes it.
      this.logger.log(
        `   ⚠️  Could not capture a reference: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * Capture the page and report what changed since the last capture.
   *
   * Deliberately gated twice before spending anything: an unchanged page never
   * reaches the AI, and a session cap bounds a hot edit loop even when every
   * save does change something.
   */
  private async runFeedback(event: WatchEvent): Promise<void> {
    const url = this.resolveFeedbackUrl(event);
    this.logger.log(`🔄 File ${event.type}: ${event.path}`);
    this.logger.log(`👁️  Observing ${url}`);

    if (!this.browserSessionActive) {
      await this.initializeBrowserSession();
    }
    if (!this.page || !this.captureEngine || !this.diffEngine) {
      throw new Error('Feedback session not initialized');
    }

    await navigate(this.page, url);
    const capture = await this.captureEngine.capture(this.page, {
      fullPage: true,
      maskSelectors: [],
      stabilizeMs: 500,
      disableAnimations: true,
      type: 'png',
    });

    if (!capture.success || !capture.buffer) {
      this.logger.log(`   ⚠️  Capture failed: ${capture.error ?? 'unknown error'}`);
      return;
    }

    if (!this.referenceCapture) {
      this.referenceCapture = capture.buffer;
      this.logger.log('   📸 Reference captured — edit a file to see what changed');
      return;
    }

    const diff = await this.diffEngine.compare(this.referenceCapture, capture.buffer, {
      threshold: FEEDBACK_DIFF_THRESHOLD,
      includeAA: false,
      alpha: 0.1,
      diffMask: true,
      diffColor: [255, 0, 0],
    });

    // `passed` means the change stayed under the threshold, i.e. nothing worth
    // asking about. This is the gate that makes a save touching no rendered
    // pixels cost nothing at all.
    if (diff.success && diff.passed) {
      this.logger.log('   ✅ No visual change');
      this.referenceCapture = capture.buffer;
      return;
    }

    if (this.aiCallsUsed >= this.options.maxAiCalls) {
      if (!this.aiCapNotified) {
        this.logger.log(
          `   ⏸️  AI call cap reached (${this.options.maxAiCalls}). Raise it with --max-ai-calls <n>.`,
        );
        this.aiCapNotified = true;
      }
      this.referenceCapture = capture.buffer;
      return;
    }

    this.aiCallsUsed++;
    let analysed = false;
    try {
      const analysis = await this.ensureClassifier().analyzeChange({
        baselineImage: this.referenceCapture,
        currentImage: capture.buffer,
        diffImage: diff.diffBuffer,
        context: { url },
      });

      if (analysis.analysisFailed) {
        // The classifier answers with a fallback shape rather than throwing, so
        // without this check a provider outage prints as a confident severity
        // whose description is really an error string.
        this.logger.error(`   ❌ AI analysis unavailable: ${analysis.description}`);
      } else {
        analysed = true;
        this.logger.log(`   🎨 ${analysis.severity.toUpperCase()}: ${analysis.description}`);
        for (const suggestion of analysis.suggestions) {
          this.logger.log(`      → ${suggestion}`);
        }
      }
    } catch (error) {
      // A watcher that dies on a provider hiccup is worse than one that says so
      // and keeps watching, which is the whole point of a companion process.
      this.logger.error(
        `   ❌ AI analysis failed: ${error instanceof Error ? error.message : error}`,
      );
    }

    // Advanced only when the change was actually reported on. Advancing after a
    // failure would compare the NEXT save against an unanalysed state, silently
    // dropping the change nobody ever heard about; holding the reference means
    // it is simply included in the next comparison.
    if (analysed) {
      this.referenceCapture = capture.buffer;
    }
  }

  private async executeInstruction(event: WatchEvent): Promise<void> {
    if (this.options.feedback) {
      try {
        await this.runFeedback(event);
      } catch (error) {
        this.logger.error(
          `\n❌ Feedback failed: ${error instanceof Error ? error.message : error}`,
        );
      }
      return;
    }

    const startTime = new Date();
    let status: 'success' | 'error' = 'success';
    const executionResults: ExecutionResult[] = [];

    try {
      this.logger.log(`🔄 File ${event.type}: ${event.path}`);
      this.logger.log(`📝 Processing: "${this.options.instruction}"`);

      // pathToFileURL escapes URL-reserved characters (#, %, ?) that plain string
      // concatenation would mis-parse when handed to page.goto().
      const fileUrl = pathToFileURL(path.resolve(this.options.cwd, event.path)).href;

      const result = await translate(this.options.instruction, {
        url: fileUrl,
      });

      this.logger.log(`✨ Translation result (${result.method}):`);
      this.logger.log(`   Actions: ${JSON.stringify(result.actions)}`);
      this.logger.log(`   Confidence: ${result.confidence}`);
      if (result.reasoning) {
        this.logger.log(`   Reasoning: ${result.reasoning}`);
      }

      if (result.actions.length === 0) {
        this.logger.log('⚠️  No actions generated from instruction');
        status = 'error';
        return;
      }

      // Execute actions if enabled. Skip execution entirely on unlink: the file is
      // gone, so there is nothing to navigate to, and running translated DOM actions
      // against the stale reused page would act on the previous file's content.
      if (this.options.execute && event.type !== 'unlink') {
        this.logger.log('\n🚀 Executing actions in browser...');

        try {
          // Ensure browser session is ready
          if (!this.browserSessionActive) {
            await this.initializeBrowserSession();
          }

          if (!this.page || !this.executor) {
            throw new Error('Browser session not initialized');
          }

          // Navigate to the changed file first so DOM-targeting actions run against
          // its real DOM rather than the blank page. This is execution setup, not a
          // translated action, so it is not counted in executionResults.
          this.logger.log(`   🌐 Navigating to ${fileUrl}`);
          await navigate(this.page, fileUrl);

          // Execute each action and report progress
          for (let i = 0; i < result.actions.length; i++) {
            const action = result.actions[i];
            this.logger.log(
              `   [${i + 1}/${result.actions.length}] Executing: ${describeAction(action)}`,
            );

            const execResult = await this.executor.executeAction(action, this.page);
            executionResults.push(execResult);

            if (execResult.success) {
              this.logger.log(`   ✅ Success (${execResult.duration}ms)`);
              if (execResult.context?.url) {
                this.logger.log(`      Current page: ${execResult.context.url}`);
              }
            } else {
              this.logger.log(`   ❌ Failed: ${execResult.error}`);
              status = 'error';
              // Continue with remaining actions instead of stopping
            }
          }

          // Final execution status
          const successCount = executionResults.filter((r) => r.success).length;
          const totalCount = executionResults.length;

          if (successCount === totalCount) {
            this.logger.log(`\n🎉 All ${totalCount} actions completed successfully!`);
          } else {
            this.logger.log(`\n⚠️  ${successCount}/${totalCount} actions completed successfully`);
            status = 'error';
          }
        } catch (executionError) {
          status = 'error';
          this.logger.error(
            '\n❌ Browser execution failed:',
            executionError instanceof Error ? executionError.message : executionError,
          );

          // Try to recover browser session
          await this.recoverBrowserSession();
        }
      } else {
        this.logger.log('\n🔍 Translation mode - actions not executed');
      }
    } catch (error) {
      status = 'error';
      this.logger.error('❌ Error processing instruction:', error);
    } finally {
      const endTime = new Date();

      // Persist to database
      try {
        const dbPath = process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');
        const db = initializeDatabase(dbPath);

        try {
          // Include execution details in the instruction field
          let instructionDetail = `${this.options.instruction} (triggered by ${event.type}: ${event.path})`;
          if (this.options.execute && executionResults.length > 0) {
            const successCount = executionResults.filter((r) => r.success).length;
            instructionDetail += ` - Executed: ${successCount}/${executionResults.length} actions`;
          }

          insertTestRun(db, {
            instruction: instructionDetail,
            status,
            startTime,
            endTime,
          });
        } finally {
          // Always close, even if insertTestRun throws, so the handle never leaks.
          db.close();
        }
      } catch (dbError) {
        this.logger.error('⚠️  Failed to persist watch execution to database:', dbError);
      }
    }
  }

  /**
   * Initialize browser session for action execution.
   */
  private async initializeBrowserSession(): Promise<void> {
    if (this.browserSessionActive) {
      return;
    }

    // Reentrancy guard: a concurrent caller awaits the in-progress init instead
    // of launching a second browser and overwriting executor/page mid-flight.
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitializeBrowserSession().finally(() => {
      this.initPromise = undefined;
    });
    return this.initPromise;
  }

  private async doInitializeBrowserSession(): Promise<void> {
    try {
      this.logger.log('🌐 Initializing browser session...');

      const executorOptions: ActionExecutorOptions = {
        timeout: this.options.browserTimeout,
        trackContext: true,
        retryAttempts: this.options.retryAttempts,
        retryDelay: this.options.retryDelay,
        browserOptions: {
          headless: this.options.headless,
          devtools: !this.options.headless, // Enable devtools in non-headless mode
        },
        // The watcher renders the changed local file, so file:// navigation is
        // expected and opted in here (blocked by default everywhere else).
        urlPolicy: { allowFile: true },
      };

      this.executor = new ActionExecutor(executorOptions);
      await this.executor.launchBrowser();
      this.page = await this.executor.createPage();
      this.browserSessionActive = true;

      this.logger.log('✅ Browser session initialized');
    } catch (error) {
      // Tear down a partially initialized session (e.g. browser launched but
      // page creation failed) so the failed init doesn't orphan a Chromium process.
      if (this.executor) {
        await this.executor.cleanup().catch(() => {});
        this.executor = undefined;
      }
      this.page = undefined;
      this.browserSessionActive = false;
      throw new Error(
        `Browser session initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Clean up browser session.
   *
   * Callers are already serialized — stop() awaits the active execution, and
   * recovery runs inside it — so unlike init this needs no reentrancy guard.
   */
  private async cleanupBrowserSession(): Promise<void> {
    // Never tear down fields an in-progress init is still assigning.
    if (this.initPromise) {
      await this.initPromise.catch(() => {});
    }

    if (!this.browserSessionActive) {
      return;
    }

    this.logger.log('🧹 Cleaning up browser session...');

    try {
      if (this.executor) {
        await this.executor.cleanup();
        this.executor = undefined;
      }
      this.page = undefined;
      this.browserSessionActive = false;
      this.logger.log('✅ Browser session cleaned up');
    } catch (error) {
      this.logger.error(
        '⚠️  Browser cleanup failed:',
        error instanceof Error ? error.message : error,
      );
      // Force cleanup
      this.executor = undefined;
      this.page = undefined;
      this.browserSessionActive = false;
    }
  }

  /**
   * Recover browser session after an error.
   */
  private async recoverBrowserSession(): Promise<void> {
    if (!this.options.execute) {
      return;
    }

    this.logger.log('🔄 Attempting browser session recovery...');

    try {
      // Clean up existing session
      await this.cleanupBrowserSession();

      // Wait a moment before retrying
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // stop() may have been called during the backoff — don't stand up a
      // fresh browser just for it to be torn straight back down.
      if (!this.isRunning) {
        return;
      }

      // Reinitialize
      await this.initializeBrowserSession();
      this.logger.log('✅ Browser session recovered');
    } catch (error) {
      this.logger.error(
        '❌ Browser session recovery failed:',
        error instanceof Error ? error.message : error,
      );
      this.browserSessionActive = false;
    }
  }

  getStatus(): {
    isRunning: boolean;
    options: Required<Omit<WatchOptions, 'quiet' | 'logger'>>;
    browserSessionActive: boolean;
  } {
    return {
      isRunning: this.isRunning,
      options: this.options,
      browserSessionActive: this.browserSessionActive,
    };
  }
}

export async function createWatcher(options: WatchOptions = {}): Promise<FileWatcher> {
  return new FileWatcher(options);
}

export interface WatchExecutionOptions {
  execute?: boolean;
  /** Suppress narration; errors still print. Threaded to the watcher's logger. */
  quiet?: boolean;
  headless?: boolean;
  browserTimeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
  feedback?: boolean;
  feedbackUrl?: string;
  maxAiCalls?: number;
  ai?: WatchOptions['ai'];
}

// Utility function for CLI usage
export async function watchFiles(
  target?: string,
  instruction?: string,
  executionOptions?: WatchExecutionOptions,
): Promise<void> {
  const options: WatchOptions = {};

  if (target) {
    // If target is a URL, we can't watch it directly
    if (target.startsWith('http://') || target.startsWith('https://')) {
      throw new Error(
        'Cannot watch remote URLs. Please specify a local directory or file pattern.',
      );
    }

    // If target is a specific file or directory, adjust patterns
    if (target.includes('*') || target.includes('?')) {
      // Target contains glob patterns
      options.patterns = [target];
    } else {
      // Target is a specific path
      const stat = await import('fs').then((fs) => fs.promises.stat(target).catch(() => null));
      if (stat?.isDirectory()) {
        options.cwd = target;
      } else {
        // A single file: watch its directory and narrow with the pattern.
        //
        // The cwd move is load-bearing under chokidar 5. chokidar 3 took the
        // path as a watch target directly, so cwd did not matter; chokidar 5
        // watches `cwd` and filters, so a file outside it would never be under
        // the watched root and `iris watch /elsewhere/page.html` would silently
        // watch nothing (issue #172).
        // Resolve the pattern too, not just cwd. A relative target carrying a
        // directory ('src/page.html') would otherwise stay verbatim while cwd
        // moved to its parent — chokidar then reports 'page.html', which never
        // matches 'src/page.html', and the watcher goes silent again. Absolute
        // patterns are converted back to cwd-relative by normalizedPatterns().
        options.patterns = [path.resolve(target)];
        options.cwd = path.dirname(path.resolve(target));
      }
    }
  }

  if (instruction) {
    options.instruction = instruction;
  }

  // Apply execution options
  if (executionOptions) {
    if (executionOptions.execute !== undefined) {
      options.execute = executionOptions.execute;
    }
    if (executionOptions.quiet !== undefined) {
      options.quiet = executionOptions.quiet;
    }
    if (executionOptions.headless !== undefined) {
      options.headless = executionOptions.headless;
    }
    if (executionOptions.browserTimeout !== undefined) {
      options.browserTimeout = executionOptions.browserTimeout;
    }
    if (executionOptions.feedback !== undefined) {
      options.feedback = executionOptions.feedback;
    }
    if (executionOptions.feedbackUrl !== undefined) {
      options.feedbackUrl = executionOptions.feedbackUrl;
    }
    if (executionOptions.maxAiCalls !== undefined) {
      options.maxAiCalls = executionOptions.maxAiCalls;
    }
    if (executionOptions.ai !== undefined) {
      options.ai = executionOptions.ai;
    }
    if (executionOptions.retryAttempts !== undefined) {
      options.retryAttempts = executionOptions.retryAttempts;
    }
    if (executionOptions.retryDelay !== undefined) {
      options.retryDelay = executionOptions.retryDelay;
    }
  }

  const watcher = await createWatcher(options);

  // Handle graceful shutdown
  const cleanup = async () => {
    // Through the watcher's sink, not console: reaching for console here would
    // defeat a caller who supplied their own logger (issue #81).
    watcher.logger.log('\n🛑 Received shutdown signal...');
    await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await watcher.start();

  // Keep the process alive
  return new Promise(() => {});
}
