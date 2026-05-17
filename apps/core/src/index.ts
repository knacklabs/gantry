import {
  installGlobalErrorHandlers,
  logger,
} from './infrastructure/logging/logger.js';
import { startMyClawRuntime } from './app/index.js';

export * from './app/index.js';

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  installGlobalErrorHandlers(logger);
  startMyClawRuntime().catch((err) => {
    logger.error({ err }, 'Failed to start Gantry');
    process.exit(1);
  });
}
