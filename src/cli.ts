#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import * as os from 'os';

const program = new Command();
program
  .name('iris')
  .description('Interface Recognition & Interaction Suite')
  .version('0.0.1');

program
  .command('run <instruction>')
  .description('Run a natural language instruction')
  .option('--dry-run', 'Only translate without executing actions')
  .option('--headless', 'Run browser in headless mode (default: true)')
  .option('--timeout <ms>', 'Timeout for actions in milliseconds', '30000')
  .action(async (instruction: string, options: { dryRun?: boolean; headless?: boolean; timeout?: string }) => {
    const startTime = new Date();
    let status: 'success' | 'error' = 'success';
    let executionResults: any[] = [];

    try {
      const { translate } = await import('./translator');
      const result = await translate(instruction);

      console.log(`✨ Translation result (${result.method}):`);
      console.log(`   Actions: ${JSON.stringify(result.actions)}`);
      console.log(`   Confidence: ${result.confidence}`);
      if (result.reasoning) {
        console.log(`   Reasoning: ${result.reasoning}`);
      }

      if (result.actions.length === 0) {
        status = 'error';
        console.log('⚠️  No actions generated from instruction');
        return;
      }

      // Execute actions unless dry-run
      if (!options.dryRun) {
        console.log('\n🚀 Executing actions...');

        const { ActionExecutor } = await import('./executor');
        const executor = new ActionExecutor({
          timeout: parseInt(options.timeout || '30000'),
          trackContext: true,
          retryAttempts: 2,
          retryDelay: 1000,
          browserOptions: {
            headless: options.headless !== false,
            devtools: options.headless === false // Enable devtools in non-headless mode
          }
        });

        try {
          // Launch browser and create page
          await executor.launchBrowser();
          const page = await executor.createPage();

          // Provide feedback about browser mode
          if (options.headless !== false) {
            console.log('   Running in headless mode...');
          } else {
            console.log('   Launching visible browser with developer tools...');
          }

          // Execute each action and report progress
          for (let i = 0; i < result.actions.length; i++) {
            const action = result.actions[i];
            console.log(`   [${i + 1}/${result.actions.length}] Executing: ${action.type} ${action.type === 'navigate' ? action.url : action.selector}${action.type === 'fill' ? ` = "${action.text}"` : ''}`);

            const execResult = await executor.executeAction(action, page);
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

          // Final status
          const successCount = executionResults.filter(r => r.success).length;
          const totalCount = executionResults.length;

          if (successCount === totalCount) {
            console.log(`\n🎉 All ${totalCount} actions completed successfully!`);
          } else {
            console.log(`\n⚠️  ${successCount}/${totalCount} actions completed successfully`);
            status = 'error';
          }

          // Clean up browser resources
          await executor.cleanup();

        } catch (executionError) {
          status = 'error';
          console.error('\n❌ Execution failed:', executionError instanceof Error ? executionError.message : executionError);

          // Ensure cleanup even on error
          try {
            await executor.cleanup();
          } catch (cleanupError) {
            // Ignore cleanup errors, but log them for debugging
            console.error('Warning: Browser cleanup failed:', cleanupError instanceof Error ? cleanupError.message : cleanupError);
          }
        }
      } else {
        console.log('\n🔍 Dry run mode - actions not executed');
      }

    } catch (error) {
      status = 'error';
      console.error('Error processing instruction:', error);
    } finally {
      const endTime = new Date();

      // Persist to database
      const { initializeDatabase, insertTestRun } = await import('./db');
      const dbPath = process.env.IRIS_DB_PATH || path.join(os.homedir(), '.iris', 'iris.db');

      // Ensure directory exists
      const dbDir = path.dirname(dbPath);
      const fs = await import('fs');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      const db = initializeDatabase(dbPath);
      insertTestRun(db, {
        instruction,
        status,
        startTime,
        endTime
      });
      db.close();
    }
  });

program
  .command('watch [target]')
  .description('Watch files or directories and trigger runs on changes')
  .option('-i, --instruction <instruction>', 'Instruction to run when files change', 'click submit')
  .option('--execute', 'Enable browser execution (default: translation only)')
  .option('--headless', 'Run browser in headless mode (default: true when executing)')
  .option('--browser-timeout <ms>', 'Browser operation timeout in milliseconds', '30000')
  .option('--retry-attempts <n>', 'Number of retry attempts for failed actions', '2')
  .option('--retry-delay <ms>', 'Delay between retry attempts in milliseconds', '1000')
  .action(async (target: string | undefined, options: {
    instruction: string;
    execute?: boolean;
    headless?: boolean;
    browserTimeout?: string;
    retryAttempts?: string;
    retryDelay?: string;
  }) => {
    try {
      const { watchFiles } = await import('./watcher');
      await watchFiles(target, options.instruction, {
        execute: options.execute,
        headless: options.headless,
        browserTimeout: options.browserTimeout ? parseInt(options.browserTimeout) : undefined,
        retryAttempts: options.retryAttempts ? parseInt(options.retryAttempts) : undefined,
        retryDelay: options.retryDelay ? parseInt(options.retryDelay) : undefined,
      });
    } catch (error) {
      console.error('Watch error:', error);
      process.exit(1);
    }
  });

program
  .command('connect [port]')
  .description('Start JSON-RPC/WebSocket server on the given port')
  .action(async (port: string | undefined) => {
    const { startServer } = await import('./protocol');
    const p = port ? Number(port) : 4000;
    startServer(p);
    console.log(`JSON-RPC server listening on ws://localhost:${p}`);
  });

export async function runCli(args: string[]): Promise<void> {
  await program.parseAsync(args, { from: 'node' });
}

if (require.main === module) {
  runCli(process.argv).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
