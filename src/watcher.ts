import chokidar from 'chokidar';
import { loadConfig } from './config';
import { translate } from './translator';
import { initializeDatabase, insertTestRun } from './db';
import { ActionExecutor, ExecutionResult, ActionExecutorOptions } from './executor';
import { Page } from 'playwright';
import * as path from 'path';
import * as os from 'os';

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
}

export interface WatchEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: Date;
}

export class FileWatcher {
  private watcher?: chokidar.FSWatcher;
  private debounceTimer?: NodeJS.Timeout;
  private options: Required<WatchOptions>;
  private isRunning = false;
  private executor?: ActionExecutor;
  private page?: Page;
  private browserSessionActive = false;

  constructor(options: WatchOptions = {}) {
    const config = loadConfig();
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
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.warn('Watcher is already running');
      return;
    }

    console.log(`🔍 Starting file watcher...`);
    console.log(`   Patterns: ${this.options.patterns.join(', ')}`);
    console.log(`   Ignoring: ${this.options.ignore.join(', ')}`);
    console.log(`   Debounce: ${this.options.debounceMs}ms`);
    console.log(`   Working directory: ${this.options.cwd}`);
    console.log(`   Mode: ${this.options.execute ? 'Execute actions' : 'Translation only'}`);

    if (this.options.execute) {
      console.log(`   Browser: ${this.options.headless ? 'Headless' : 'Visible'}`);
      console.log(`   Timeout: ${this.options.browserTimeout}ms`);
      try {
        await this.initializeBrowserSession();
      } catch (error) {
        console.error('Failed to initialize browser session:', error);
        throw error;
      }
    }

    this.watcher = chokidar.watch(this.options.patterns, {
      ignored: this.options.ignore,
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
      .on('error', (error) => console.error('Watcher error:', error))
      .on('ready', () => {
        this.isRunning = true;
        console.log('🎯 File watcher ready. Waiting for changes...');
      });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('⏹️  Stopping file watcher...');

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }

    // Clean up browser session
    await this.cleanupBrowserSession();

    this.isRunning = false;
    console.log('✅ File watcher stopped');
  }

  private handleFileEvent(type: 'add' | 'change' | 'unlink', filePath: string): void {
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
      this.executeInstruction(event);
    }, this.options.debounceMs);
  }

  private async executeInstruction(event: WatchEvent): Promise<void> {
    const startTime = new Date();
    let status: 'success' | 'error' = 'success';
    let executionResults: ExecutionResult[] = [];

    try {
      console.log(`🔄 File ${event.type}: ${event.path}`);
      console.log(`📝 Processing: "${this.options.instruction}"`);

      const result = await translate(this.options.instruction, {
        url: `file://${path.resolve(this.options.cwd, event.path)}`,
      });

      console.log(`✨ Translation result (${result.method}):`);
      console.log(`   Actions: ${JSON.stringify(result.actions)}`);
      console.log(`   Confidence: ${result.confidence}`);
      if (result.reasoning) {
        console.log(`   Reasoning: ${result.reasoning}`);
      }

      if (result.actions.length === 0) {
        console.log('⚠️  No actions generated from instruction');
        status = 'error';
        return;
      }

      // Execute actions if enabled
      if (this.options.execute) {
        console.log('\n🚀 Executing actions in browser...');

        try {
          // Ensure browser session is ready
          if (!this.browserSessionActive) {
            await this.initializeBrowserSession();
          }

          if (!this.page || !this.executor) {
            throw new Error('Browser session not initialized');
          }

          // Execute each action and report progress
          for (let i = 0; i < result.actions.length; i++) {
            const action = result.actions[i];
            console.log(`   [${i + 1}/${result.actions.length}] Executing: ${action.type} ${action.type === 'navigate' ? action.url : action.selector}${action.type === 'fill' ? ` = "${action.text}"` : ''}`);

            const execResult = await this.executor.executeAction(action, this.page);
            executionResults.push(execResult);

            if (execResult.success) {
              console.log(`   ✅ Success (${execResult.duration}ms)`);
              if (execResult.context?.url) {
                console.log(`      Current page: ${execResult.context.url}`);
              }
            } else {
              console.log(`   ❌ Failed: ${execResult.error}`);
              status = 'error';
              // Continue with remaining actions instead of stopping
            }
          }

          // Final execution status
          const successCount = executionResults.filter(r => r.success).length;
          const totalCount = executionResults.length;

          if (successCount === totalCount) {
            console.log(`\n🎉 All ${totalCount} actions completed successfully!`);
          } else {
            console.log(`\n⚠️  ${successCount}/${totalCount} actions completed successfully`);
            status = 'error';
          }

        } catch (executionError) {
          status = 'error';
          console.error('\n❌ Browser execution failed:', executionError instanceof Error ? executionError.message : executionError);

          // Try to recover browser session
          await this.recoverBrowserSession();
        }
      } else {
        console.log('\n🔍 Translation mode - actions not executed');
      }

    } catch (error) {
      status = 'error';
      console.error('❌ Error processing instruction:', error);
    } finally {
      const endTime = new Date();

      // Persist to database
      try {
        const dbPath = process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');
        const db = initializeDatabase(dbPath);

        // Include execution details in the instruction field
        let instructionDetail = `${this.options.instruction} (triggered by ${event.type}: ${event.path})`;
        if (this.options.execute && executionResults.length > 0) {
          const successCount = executionResults.filter(r => r.success).length;
          instructionDetail += ` - Executed: ${successCount}/${executionResults.length} actions`;
        }

        insertTestRun(db, {
          instruction: instructionDetail,
          status,
          startTime,
          endTime,
        });
        db.close();
      } catch (dbError) {
        console.error('⚠️  Failed to persist watch execution to database:', dbError);
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

    try {
      console.log('🌐 Initializing browser session...');

      const executorOptions: ActionExecutorOptions = {
        timeout: this.options.browserTimeout,
        trackContext: true,
        retryAttempts: this.options.retryAttempts,
        retryDelay: this.options.retryDelay,
        browserOptions: {
          headless: this.options.headless,
          devtools: !this.options.headless // Enable devtools in non-headless mode
        }
      };

      this.executor = new ActionExecutor(executorOptions);
      await this.executor.launchBrowser();
      this.page = await this.executor.createPage();
      this.browserSessionActive = true;

      console.log('✅ Browser session initialized');
    } catch (error) {
      this.browserSessionActive = false;
      throw new Error(`Browser session initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Clean up browser session.
   */
  private async cleanupBrowserSession(): Promise<void> {
    if (!this.browserSessionActive) {
      return;
    }

    console.log('🧹 Cleaning up browser session...');

    try {
      if (this.executor) {
        await this.executor.cleanup();
        this.executor = undefined;
      }
      this.page = undefined;
      this.browserSessionActive = false;
      console.log('✅ Browser session cleaned up');
    } catch (error) {
      console.error('⚠️  Browser cleanup failed:', error instanceof Error ? error.message : error);
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

    console.log('🔄 Attempting browser session recovery...');

    try {
      // Clean up existing session
      await this.cleanupBrowserSession();

      // Wait a moment before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Reinitialize
      await this.initializeBrowserSession();
      console.log('✅ Browser session recovered');
    } catch (error) {
      console.error('❌ Browser session recovery failed:', error instanceof Error ? error.message : error);
      this.browserSessionActive = false;
    }
  }

  getStatus(): { isRunning: boolean; options: Required<WatchOptions>; browserSessionActive: boolean } {
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
  headless?: boolean;
  browserTimeout?: number;
  retryAttempts?: number;
  retryDelay?: number;
}

// Utility function for CLI usage
export async function watchFiles(
  target?: string,
  instruction?: string,
  executionOptions?: WatchExecutionOptions
): Promise<void> {
  const options: WatchOptions = {};

  if (target) {
    // If target is a URL, we can't watch it directly
    if (target.startsWith('http://') || target.startsWith('https://')) {
      throw new Error('Cannot watch remote URLs. Please specify a local directory or file pattern.');
    }

    // If target is a specific file or directory, adjust patterns
    if (target.includes('*') || target.includes('?')) {
      // Target contains glob patterns
      options.patterns = [target];
    } else {
      // Target is a specific path
      const stat = await import('fs').then(fs => fs.promises.stat(target).catch(() => null));
      if (stat?.isDirectory()) {
        options.cwd = target;
      } else {
        // Treat as file pattern
        options.patterns = [target];
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
    if (executionOptions.headless !== undefined) {
      options.headless = executionOptions.headless;
    }
    if (executionOptions.browserTimeout !== undefined) {
      options.browserTimeout = executionOptions.browserTimeout;
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
    console.log('\n🛑 Received shutdown signal...');
    await watcher.stop();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await watcher.start();

  // Keep the process alive
  return new Promise(() => {});
}