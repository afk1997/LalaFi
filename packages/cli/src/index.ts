#!/usr/bin/env node
import { buildProgram } from './program.js';
import { CliError } from './io.js';

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
    process.exit(0);
  } catch (e) {
    // Print only the message: errors never carry secrets, but stacks may include argument values.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`error: ${msg}\n`);
    if (process.env.XPOOL_DEBUG && e instanceof Error && e.stack) process.stderr.write(`${e.stack}\n`);
    process.exit(e instanceof CliError ? e.exitCode : 1);
  }
}

void main();
