import {
  installGlobalErrorHandlers,
  logger,
} from './infrastructure/logging/logger.js';
import { startGantryRuntime } from './app/index.js';

export * from './app/index.js';
export * from './jobs/host-task-executors.js';

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  installGlobalErrorHandlers(logger);
  startGantryRuntime().catch((err) => {
    logger.error({ err }, 'Failed to start Gantry');
    process.exit(1);
  });
}
