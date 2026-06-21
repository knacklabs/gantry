import {
  getRuntimeStorage,
  tryAcquireRuntimeAdvisoryLease,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  DEFAULT_IDLE_SWEEP_CONCURRENCY,
  DEFAULT_IDLE_SWEEP_EXTRACTION_TIMEOUT_MS,
} from '../config/settings/runtime-settings-defaults.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import { logger } from '../infrastructure/logging/logger.js';
import { resolveDigestAndShortMemoryWatcherConfigs } from './digest-and-short-memory-watcher-config.js';
import { drainBatches } from './idle-sweep-drain.js';

const DEFAULT_MAX_PER_SWEEP = 25;

// Single-flight across instances: only one runtime sweeps at a time. Prevents the
// documented orphaned-`npm run dev` case (multiple pollers on one Postgres) from
// double-extracting. Correctness is already covered by the memory_items unique
// constraint; this avoids the wasted duplicate Haiku calls.
const SWEEP_LEASE_KEY = 'gantry:idle-session-sweep';

// Bounded retry: a session whose extraction keeps failing (e.g. the boundary LLM
// call repeatedly times out) must NOT be retried every sweep forever — that burns
// Haiku calls. A failed attempt does not advance the conversation's extraction
// cursor, so the row stays eligible; we back off exponentially (per session,
// in-memory) instead. Cleared on success or process restart.
const RETRY_BACKOFF_BASE_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 30 * 60_000;

export function resolveDigestAndShortMemoryWatcherPollIntervalMs():
  | number
  | undefined {
  const intervals = [
    ...resolveDigestAndShortMemoryWatcherConfigs().values(),
  ].map((watcher) => watcher.pollIntervalMs);
  return intervals.length > 0 ? Math.min(...intervals) : undefined;
}

interface IdleCandidateRow {
  agent_session_id: string;
  agent_id: string;
  last_activity_at: string;
  last_inbound_at: string;
}

// Eligible = an opt-in agent's active session whose whole conversation has been
// quiet (last message of ANY direction older than the loosest cutoff) AND has new
// customer input since the conversation's extraction cursor
// (last_inbound_at > covered_through_at). The per-conversation cursor (keyed on
// conversation_id + thread_id + agent_id) is advanced by the boundary extractor
// after a successful run, preventing re-sweeping. A null cursor means the
// conversation has never been extracted and is therefore always eligible.
// Per-agent precise idle is re-checked in code.
export const IDLE_CANDIDATES_SQL = `
  SELECT s.id AS agent_session_id,
         s.agent_id,
         act.last_activity_at,
         inb.last_inbound_at
  FROM agent_sessions s
  JOIN LATERAL (
    SELECT max(m.created_at) AS last_activity_at
    FROM messages m
    WHERE m.conversation_id = s.conversation_id
      AND m.thread_id IS NOT DISTINCT FROM s.thread_id
  ) act ON TRUE
  JOIN LATERAL (
    SELECT max(m.created_at) AS last_inbound_at
    FROM messages m
    WHERE m.conversation_id = s.conversation_id
      AND m.thread_id IS NOT DISTINCT FROM s.thread_id
      AND m.direction = 'inbound'
  ) inb ON TRUE
  LEFT JOIN LATERAL (
    SELECT c.covered_through_at
    FROM memory_extraction_cursor c
    WHERE c.conversation_id = s.conversation_id
      AND c.thread_id IS NOT DISTINCT FROM s.thread_id
      AND c.agent_id = s.agent_id
      AND c.app_id = s.app_id
    LIMIT 1
  ) cur ON TRUE
  WHERE s.status = 'active'
    AND s.conversation_id IS NOT NULL
    AND s.agent_id = ANY($1::text[])
    AND act.last_activity_at IS NOT NULL
    AND act.last_activity_at <= $2::timestamptz
    AND inb.last_inbound_at IS NOT NULL
    AND (cur.covered_through_at IS NULL OR inb.last_inbound_at > cur.covered_through_at)
  ORDER BY act.last_activity_at ASC
  LIMIT $3
`;

export interface IdleSweepDeps {
  collectSessionMemory: SessionMemoryCollector;
  maxPerSweep?: number;
  // How many of the per-pass batch to extract in parallel (default 3). Background
  // work shares the model rate budget with live replies, so keep this low.
  concurrency?: number;
  // Per-extraction deadline threaded to the boundary extractor (default 45s).
  extractionTimeoutMs?: number;
  now?: () => number;
}

export interface IdleSessionSweepLoopHandle {
  close(): void;
}

export function startIdleSessionSweepLoop(input: {
  runSweep: () => Promise<void>;
  intervalMs: number;
  logger: Pick<typeof logger, 'warn'>;
}): IdleSessionSweepLoopHandle {
  let closed = false;
  let running = false;
  const runOnce = async (): Promise<void> => {
    if (closed || running) return;
    running = true;
    try {
      await input.runSweep();
    } catch (err) {
      input.logger.warn({ err }, 'Idle session sweep tick failed');
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => void runOnce(), input.intervalMs);
  interval.unref?.();

  return {
    close: () => {
      closed = true;
      clearInterval(interval);
    },
  };
}

/**
 * Builds the idle-session sweeper used by the poll loop. The returned function
 * runs one pass: find idle opt-in sessions and run the existing session-end
 * memory extraction for each. It changes no session state — idempotency comes
 * from the per-conversation extraction cursor the collector advances. Failures
 * are logged and retried next pass (cursor not advanced). Safe to call when
 * nothing is opted in (no-op).
 */
export function createIdleSessionSweeper(
  deps: IdleSweepDeps,
): () => Promise<void> {
  const maxPerSweep = deps.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
  const concurrency = deps.concurrency ?? DEFAULT_IDLE_SWEEP_CONCURRENCY;
  const extractionTimeoutMs =
    deps.extractionTimeoutMs ?? DEFAULT_IDLE_SWEEP_EXTRACTION_TIMEOUT_MS;
  const now = deps.now ?? (() => Date.now());
  // Per-session failure back-off (in-memory; cleared on success or restart).
  const backoff = new Map<
    string,
    { failures: number; nextEligibleAt: number }
  >();

  // Startup visibility: announce which agents have the watcher enabled.
  // Nothing is logged when no watcher is enabled, so silent-off is observable.
  for (const [
    agentId,
    watcher,
  ] of resolveDigestAndShortMemoryWatcherConfigs()) {
    logger.info(
      {
        agentId,
        conversationIdleAfterMs: watcher.conversationIdleAfterMs,
        model: watcher.model,
      },
      'Digest and short-memory watcher enabled',
    );
  }

  return async function runIdleSessionSweep(): Promise<void> {
    const optIn = resolveDigestAndShortMemoryWatcherConfigs();
    if (optIn.size === 0) return;

    // Single-flight across instances. If another runtime holds the lease, skip
    // this pass (it sweeps instead). Idempotency still protects us on any overlap.
    const lease = await tryAcquireRuntimeAdvisoryLease(SWEEP_LEASE_KEY);
    if (!lease) return;
    try {
      const nowMs = now();
      let minCutoffMs = Number.POSITIVE_INFINITY;
      for (const watcher of optIn.values()) {
        minCutoffMs = Math.min(minCutoffMs, watcher.conversationIdleAfterMs);
      }
      const idleBeforeIso = new Date(nowMs - minCutoffMs).toISOString();
      const agentIds = [...optIn.keys()];

      let pool: ReturnType<typeof getRuntimeStorage>['service']['pool'];
      try {
        pool = getRuntimeStorage().service.pool;
        // eslint-disable-next-line no-catch-all/no-catch-all -- Storage not ready yet; skip this pass.
      } catch {
        return;
      }

      // Fetch one batch of eligible sessions: the loose-idle SQL candidates filtered
      // by the precise per-agent idle cutoff and the in-memory failure back-off.
      const fetchEligibleBatch = async (): Promise<IdleCandidateRow[]> => {
        let rows: IdleCandidateRow[];
        try {
          const result = await pool.query<IdleCandidateRow>(
            IDLE_CANDIDATES_SQL,
            [agentIds, idleBeforeIso, maxPerSweep * 4],
          );
          rows = result.rows;
        } catch (err) {
          logger.warn({ err }, 'Idle session sweep query failed');
          return [];
        }
        const eligible: IdleCandidateRow[] = [];
        for (const row of rows) {
          if (eligible.length >= maxPerSweep) break;
          const watcher = optIn.get(row.agent_id);
          if (!watcher) continue;
          const lastActivityMs = Date.parse(row.last_activity_at);
          if (!Number.isFinite(lastActivityMs)) continue;
          // Precise per-agent idle check (the SQL used the loosest cutoff).
          if (nowMs - lastActivityMs < watcher.conversationIdleAfterMs) {
            continue;
          }
          // Bounded retry: skip a session still inside its failure back-off window.
          const prior = backoff.get(row.agent_session_id);
          if (prior && nowMs < prior.nextEligibleAt) continue;
          eligible.push(row);
        }
        return eligible;
      };

      // Extract one session. Owns its own error handling so a failure never aborts
      // the batch (it backs the session off and lets the others proceed).
      const processSession = async (row: IdleCandidateRow): Promise<void> => {
        try {
          const outcome = await deps.collectSessionMemory({
            agentSessionId: row.agent_session_id,
            trigger: 'session-end',
            // DM customer agents (the opt-in case today) are user-scoped. A
            // channel/group agent that opts in later would need kind-based scope.
            defaultScope: 'user',
            model: optIn.get(row.agent_id)?.model,
            timeoutMs: extractionTimeoutMs,
          });
          backoff.delete(row.agent_session_id);
          logger.info(
            {
              agentSessionId: row.agent_session_id,
              agentId: row.agent_id,
              saved: outcome.saved,
            },
            'Idle session memory extracted',
          );
        } catch (err) {
          const failures =
            (backoff.get(row.agent_session_id)?.failures ?? 0) + 1;
          const delay = Math.min(
            RETRY_BACKOFF_BASE_MS * 2 ** (failures - 1),
            RETRY_BACKOFF_MAX_MS,
          );
          backoff.set(row.agent_session_id, {
            failures,
            nextEligibleAt: nowMs + delay,
          });
          logger.warn(
            {
              err,
              agentSessionId: row.agent_session_id,
              failures,
              retryInMs: delay,
            },
            'Idle session memory extraction failed; backing off before retry',
          );
        }
      };

      // Adaptive drain: extract each batch with bounded parallelism, and keep pulling
      // batches while they come back full (more backlog) rather than waiting for the
      // next poll interval. Re-querying each round is safe and terminating: a success
      // advances the conversation cursor (row drops out) and a failure sets an
      // in-memory back-off (fetchEligibleBatch skips it), so the loop makes progress
      // and stops on the first partial batch.
      await drainBatches({
        fetchBatch: fetchEligibleBatch,
        processItem: processSession,
        batchSize: maxPerSweep,
        concurrency,
      });
    } finally {
      await lease.release();
    }
  };
}
