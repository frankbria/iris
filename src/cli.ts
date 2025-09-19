#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('iris')
  .description('Interface Recognition & Interaction Suite')
  .version('0.0.1');

program
  .command('run <instruction>')
  .description('Run a natural language instruction')
  .action(async (instruction: string) => {
    const { translate } = await import('./translator');
    const actions = translate(instruction);
    console.log(JSON.stringify(actions));
  });

program
  .command('watch [target]')
  .description('Watch files or URL and trigger runs')
  .action((target: string | undefined) => {
    console.log(`Watching: ${target ?? 'default'}`);
  });

program
  .command('connect')
  .description('Start JSON-RPC/WebSocket server')
  .action(() => {
    console.log('Starting JSON-RPC/WebSocket server...');
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
