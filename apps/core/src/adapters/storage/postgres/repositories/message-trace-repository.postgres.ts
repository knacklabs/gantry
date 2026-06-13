import type { LatencyTimings } from '../../../../runtime/reply-trace.js';
import { messageTracesPostgres } from '../schema/message-traces.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export type MessageTraceKind = 'reply' | 'command';

export interface MessageTraceRow {
  /** Canonical message id (message:${chatJid}:${id}) — FK to messages.id. */
  messageId: string;
  appId: string;
  conversationId: string;
  kind: MessageTraceKind;
  totalMs: number;
  timingsJson: LatencyTimings;
  payloadsJson: Record<number, unknown> | null;
  /** ISO timestamp string (timestamptz mode: 'string'). */
  createdAt: string;
}

interface TraceRepoLogger {
  warn: (payload: Record<string, unknown>, message: string) => void;
}

/**
 * Best-effort persistence for the per-reply latency trace.
 *
 * INVARIANT: a trace failure (db down, FK race, constraint) must NEVER throw
 * into the reply path. `save` swallows every error and logs at warn. The trace
 * is diagnostics-only; the customer reply has already been sent by the time
 * this runs.
 */
export class PostgresMessageTraceRepository {
  constructor(
    private readonly db: CanonicalDb,
    private readonly logger?: TraceRepoLogger,
  ) {}

  async save(row: MessageTraceRow): Promise<void> {
    try {
      await this.db
        .insert(messageTracesPostgres)
        .values(row)
        .onConflictDoNothing();
    } catch (err) {
      this.logger?.warn(
        {
          err,
          messageId: row.messageId,
          conversationId: row.conversationId,
          kind: row.kind,
        },
        'Failed to persist message trace (best-effort, ignored)',
      );
    }
  }
}
