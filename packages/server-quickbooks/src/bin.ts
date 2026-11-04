#!/usr/bin/env node
import { createLogger, loadConfig, main, runServer } from '@abhijoshi23/porter-toolkit';
import { runCli } from './auth-cli.js';
import { configSchema, createQuickBooksServer, NAME } from './server.js';

const [cmd] = process.argv.slice(2);

if (cmd) {
  // A person at a terminal: plain output, exit code.
  try {
    const config = loadConfig(configSchema);
    const log = createLogger(NAME, config.LOG_LEVEL === 'info' ? 'warn' : config.LOG_LEVEL);
    process.exitCode = await runCli(
      process.argv.slice(2),
      { config, log },
      // Subcommands talk to a person, so stdout is fine here (never in server mode).
      { out: (line) => process.stdout.write(`${line}\n`) },
    );
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
} else {
  void main(async () => {
    const config = loadConfig(configSchema);
    const log = createLogger(NAME, config.LOG_LEVEL);
    return runServer(createQuickBooksServer({ config, log }), config, log);
  });
}
