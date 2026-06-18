import { sql } from 'drizzle-orm';

import { nowIso as currentIso } from '../../../../shared/time/datetime.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';

export interface OldestWaitingLiveAdmission {
  conversationJid: string;
  threadId: string | null;
  waitingSince: string;
  ageSeconds: number;
}

export async function getOldestWaitingLiveAdmission(
  db: CanonicalDb,
  input: {
    conversationJids: string[];
    now?: string;
  },
): Promise<OldestWaitingLiveAdmission | null> {
  if (input.conversationJids.length === 0) return null;
  const now = input.now ?? currentIso();
  // messages.conversation_id is `conversation:<jid>`; live_turns.conversation_id
  // is the raw jid. Normalize the routed input once so live_turns predicates stay
  // plain-column comparisons instead of expression joins.
  const routed = sql.join(
    input.conversationJids.map(
      (jid) => sql`(${jid}::text, ${`conversation:${jid}`}::text)`,
    ),
    sql`, `,
  );
  const result = await db.execute<{
    conversation_jid: string;
    thread_id: string | null;
    waiting_since: string;
    age_seconds: number;
  }>(sql`
    WITH routed(raw_jid, conversation_id) AS (
      VALUES ${routed}
    )
    SELECT routed.raw_jid AS conversation_jid,
           m.thread_id,
           m.created_at AS waiting_since,
           floor(extract(epoch FROM (${now}::timestamptz - m.created_at)))::int AS age_seconds
    FROM routed
    INNER JOIN messages m ON m.conversation_id = routed.conversation_id
    WHERE m.direction = 'inbound'
      AND NOT EXISTS (
        SELECT 1 FROM live_turns lt
        WHERE lt.conversation_id = routed.raw_jid
          AND lt.state NOT IN ('completed', 'failed', 'timed_out')
      )
      AND m.created_at > COALESCE(
        (SELECT max(COALESCE(lt2.ended_at, lt2.updated_at, lt2.created_at))
         FROM live_turns lt2
         WHERE lt2.conversation_id = routed.raw_jid),
        '-infinity'::timestamptz
      )
    ORDER BY m.created_at ASC
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    conversationJid: row.conversation_jid,
    threadId: row.thread_id,
    waitingSince: String(row.waiting_since),
    ageSeconds: Number(row.age_seconds) || 0,
  };
}
