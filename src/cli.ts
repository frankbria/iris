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
  .action(async (instruction: string) => {
    const startTime = new Date();
    let status: 'success' | 'error' = 'success';

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
      }
    } catch (error) {
      status = 'error';
      console.error('Error executing instruction:', error);
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
  .action(async (target: string | undefined, options: { instruction: string }) => {
    try {
      const { watchFiles } = await import('./watcher');
      await watchFiles(target, options.instruction);
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
