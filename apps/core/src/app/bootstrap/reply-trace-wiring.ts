import { getRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import {
  PostgresMessageTraceRepository,
  type MessageTraceRow,
} from '../../adapters/storage/postgres/repositories/message-trace-repository.postgres.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { ReplyTracePort } from '../../runtime/group-processing-types.js';
import {
  RunTraceCollector,
  tracePayloadsEnabled,
  type ToolCallRecord,
} from '../../runtime/reply-trace.js';

export interface ReplyTraceWiring {
  /** Passed into the group processor deps (drain + persist). */
  port: ReplyTracePort;
  /** Passed into the IPC handler deps to capture each MCP call. */
  recordReplyToolCall: (runHandle: string, record: ToolCallRecord) => void;
}

/**
 * Build the single process-wide reply-trace wiring: one `RunTraceCollector`
 * shared between the IPC MCP-capture site and the persist-time drain, plus a
 * best-effort trace repository (lazily bound to the runtime storage so it works
 * regardless of bootstrap ordering). All paths are best-effort and never throw.
 */
export function createReplyTraceWiring(): ReplyTraceWiring {
  const collector = new RunTraceCollector();
  let repo: PostgresMessageTraceRepository | undefined;
  const resolveRepo = (): PostgresMessageTraceRepository | undefined => {
    if (repo) return repo;
    try {
      repo = new PostgresMessageTraceRepository(getRuntimeStorage().service.db, {
        warn: (payload, message) => logger.warn(payload, message),
      });
    } catch (err) {
      logger.warn({ err }, 'Reply-trace repository unavailable (ignored)');
      return undefined;
    }
    return repo;
  };

  const port: ReplyTracePort = {
    drain: (runHandle) => collector.drain(runHandle),
    saveTrace: async (row: MessageTraceRow) => {
      await resolveRepo()?.save(row);
    },
    payloadsEnabled: tracePayloadsEnabled,
  };

  return {
    port,
    recordReplyToolCall: (runHandle, record) =>
      collector.recordTool(runHandle, record),
  };
}
