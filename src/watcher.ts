import chokidar from 'chokidar';
import { loadConfig } from './config';
import { translate } from './translator';
import { initializeDatabase, insertTestRun } from './db';
import * as path from 'path';
import * as os from 'os';

export interface WatchOptions {
  patterns?: string[];
  ignore?: string[];
  debounceMs?: number;
  cwd?: string;
  instruction?: string;
  persistent?: boolean;
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

  constructor(options: WatchOptions = {}) {
    const config = loadConfig();
    this.options = {
      patterns: options.patterns || config.watch.patterns,
      ignore: options.ignore || config.watch.ignore,
      debounceMs: options.debounceMs || config.watch.debounceMs,
      cwd: options.cwd || process.cwd(),
      instruction: options.instruction || 'click submit',
      persistent: options.persistent ?? true,
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

    try {
      console.log(`🔄 File ${event.type}: ${event.path}`);
      console.log(`📝 Executing: "${this.options.instruction}"`);

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
      }
    } catch (error) {
      status = 'error';
      console.error('❌ Error executing instruction:', error);
    } finally {
      const endTime = new Date();

      // Persist to database
      try {
        const dbPath = process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');
        const db = initializeDatabase(dbPath);
        insertTestRun(db, {
          instruction: `${this.options.instruction} (triggered by ${event.type}: ${event.path})`,
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

  getStatus(): { isRunning: boolean; options: Required<WatchOptions> } {
    return {
      isRunning: this.isRunning,
      options: this.options,
    };
  }
}

export async function createWatcher(options: WatchOptions = {}): Promise<FileWatcher> {
  return new FileWatcher(options);
}

// Utility function for CLI usage
export async function watchFiles(
  target?: string,
  instruction?: string
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