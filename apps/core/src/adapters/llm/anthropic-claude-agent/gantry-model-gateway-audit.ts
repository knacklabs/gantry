import type { RuntimeEventPublishInput } from '../../../domain/events/events.js';
import { logger } from '../../../infrastructure/logging/logger.js';

type AuditSink = (
  event: RuntimeEventPublishInput,
) => Promise<unknown> | unknown;

// Drizzle wraps the pg driver error, so the SQLSTATE + constraint live on the
// cause chain (same walk the postgres repositories use for 23505).
function isRunIdForeignKeyViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== 'object') return false;
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === '23503' && constraint === 'runtime_events_run_id_fkey') {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// A run-id with no `agent_runs` row trips the runtime_events FK. Keep the
// usage/cost record by retrying once unscoped instead of losing the audit row
// (and spamming WARNs). Only this specific FK violation is retried.
export async function publishAuditEventWithRunIdFallback(
  audit: AuditSink,
  event: RuntimeEventPublishInput,
  failureMessage: string,
): Promise<void> {
  try {
    await audit(event);
  } catch (err) {
    if (event.runId === undefined || !isRunIdForeignKeyViolation(err)) {
      logger.warn({ err }, failureMessage);
      return;
    }
    const { runId: _dropped, ...unscoped } = event;
    try {
      await audit(unscoped);
    } catch (retryErr) {
      logger.warn({ err: retryErr }, failureMessage);
    }
  }
}
