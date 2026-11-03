#!/usr/bin/env node
import { createLogger, loadConfig, main, runServer } from '@abhijoshi23/porter-toolkit';
import { configSchema, createTendersServer, NAME } from './server.js';

void main(async () => {
  const config = loadConfig(configSchema);
  const log = createLogger(NAME, config.LOG_LEVEL);
  return runServer(createTendersServer({ config, log }), config, log);
});
