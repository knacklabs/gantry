import { execFile } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../core/logger.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SOURCE_DIR, '..', '..');
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'cleanup-sessions.sh');

function runCleanup(): void {
  execFile('bash', [SCRIPT_PATH], { timeout: 60_000 }, (err, stdout) => {
    if (err) {
      logger.error({ err }, 'Session cleanup failed');
      return;
    }
    const summary = stdout.trim().split('\n').pop();
    if (summary) logger.info(summary);
  });
}

export function startSessionCleanup(): void {
  // Run once at startup (delayed 30s to not compete with init)
  const initialRun = setTimeout(runCleanup, 30_000);
  initialRun.unref?.();
  // Then every 24 hours
  const recurringRun = setInterval(runCleanup, CLEANUP_INTERVAL);
  recurringRun.unref?.();
}
