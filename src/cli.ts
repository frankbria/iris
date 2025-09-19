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
  .action((instruction: string) => {
    console.log(`Running instruction: ${instruction}`);
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

export function runCli(args: string[]): void {
  program.parse(args, { from: 'node' });
}

if (require.main === module) {
  runCli(process.argv);
}
