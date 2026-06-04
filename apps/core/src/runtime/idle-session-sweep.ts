import {
  getRuntimeStorage,
  tryAcquireRuntimeAdvisoryLease,
} from '../adapters/storage/postgres/runtime-store.js';
import { getRuntimeSettingsForConfig } from '../config/index.js';
import { agentIdForFolder } from '../config/settings/desired-state-service-helpers.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import { logger } from '../infrastructure/logging/logger.js';

const MS_PER_MINUTE = 60_000;
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

/**
 * How often the poll loop should run a sweep. The detection latency for an idle
 * chat is at most one interval, so this is kept well under the smallest sensible
 * `idle_end_minutes`. The query itself is a single indexed lookup, so a 30s
 * cadence is cheap even with a 30-minute production window.
 */
export const IDLE_SWEEP_INTERVAL_MS = 30_000;

/**
 * Map of opt-in agentId -> idle cutoff in ms. Empty when no agent declared
 * `memory.idle_end_minutes`, which makes the whole sweep a no-op.
 */
function resolveIdleExtractionAgents(): Map<string, number> {
  const result = new Map<string, number>();
  let agents: ReturnType<typeof getRuntimeSettingsForConfig>['agents'];
  try {
    agents = getRuntimeSettingsForConfig().agents;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Unreadable settings means "no opt-in agents"; the sweep simply does nothing.
  } catch {
    return result;
  }
  for (const [folder, agent] of Object.entries(agents)) {
    const minutes = agent.memory?.idleEndMinutes;
    if (typeof minutes === 'number' && minutes > 0) {
      result.set(agentIdForFolder(folder), minutes * MS_PER_MINUTE);
    }
  }
  return result;
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
    SELECT c.covered_through_at AS covered_through_at
    FROM memory_extraction_cursor c
    WHERE c.conversation_id = s.conversation_id
      AND c.thread_id IS NOT DISTINCT FROM s.thread_id
      AND c.agent_id = s.agent_id
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
  now?: () => number;
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
  const now = deps.now ?? (() => Date.now());
  // Per-session failure back-off (in-memory; cleared on success or restart).
  const backoff = new Map<
    string,
    { failures: number; nextEligibleAt: number }
  >();

  // Startup visibility: announce which agents have idle extraction on (and N).
  // Nothing is logged when no agent opted in, so silent-off is observable.
  for (const [agentId, cutoffMs] of resolveIdleExtractionAgents()) {
    logger.info(
      { agentId, idleEndMinutes: cutoffMs / MS_PER_MINUTE },
      'Idle memory extraction enabled',
    );
  }

  return async function runIdleSessionSweep(): Promise<void> {
    const optIn = resolveIdleExtractionAgents();
    if (optIn.size === 0) return;

    // Single-flight across instances. If another runtime holds the lease, skip
    // this pass (it sweeps instead). Idempotency still protects us on any overlap.
    const lease = await tryAcquireRuntimeAdvisoryLease(SWEEP_LEASE_KEY);
    if (!lease) return;
    try {
      const nowMs = now();
      let minCutoffMs = Number.POSITIVE_INFINITY;
      for (const cutoff of optIn.values()) {
        minCutoffMs = Math.min(minCutoffMs, cutoff);
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

      let rows: IdleCandidateRow[];
      try {
        const result = await pool.query<IdleCandidateRow>(IDLE_CANDIDATES_SQL, [
          agentIds,
          idleBeforeIso,
          maxPerSweep * 4,
        ]);
        rows = result.rows;
      } catch (err) {
        logger.warn({ err }, 'Idle session sweep query failed');
        return;
      }

      let extracted = 0;
      for (const row of rows) {
        if (extracted >= maxPerSweep) break;
        const cutoffMs = optIn.get(row.agent_id);
        if (cutoffMs === undefined) continue;
        const lastActivityMs = Date.parse(row.last_activity_at);
        if (!Number.isFinite(lastActivityMs)) continue;
        // Precise per-agent idle check (the SQL used the loosest cutoff).
        if (nowMs - lastActivityMs < cutoffMs) continue;
        // Bounded retry: skip a session still inside its failure back-off window.
        const prior = backoff.get(row.agent_session_id);
        if (prior && nowMs < prior.nextEligibleAt) continue;
        try {
          const outcome = await deps.collectSessionMemory({
            agentSessionId: row.agent_session_id,
            trigger: 'session-end',
            // DM customer agents (the opt-in case today) are user-scoped. A
            // channel/group agent that opts in later would need kind-based scope.
            defaultScope: 'user',
          });
          extracted += 1;
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
      }
    } finally {
      await lease.release();
    }
  };
}
