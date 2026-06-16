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
  // is the raw jid. A message waits when no non-terminal turn covers its
  // conversation AND it arrived after the conversation's latest turn
  // high-water mark (terminal turns bound by ended_at: continuations handled
  // mid-turn are newer than created_at yet covered). Conversation-level on
  // purpose because reverse-parsing canonical thread ids is fragile.
  const prefixed = sql.join(
    input.conversationJids.map((jid) => sql`${`conversation:${jid}`}`),
    sql`, `,
  );
  const result = await db.execute<{
    conversation_id: string;
    waiting_since: string;
    age_seconds: number;
  }>(sql`
    SELECT m.conversation_id,
           m.created_at AS waiting_since,
           floor(extract(epoch FROM (${now}::timestamptz - m.created_at)))::int AS age_seconds
    FROM messages m
    WHERE m.conversation_id IN (${prefixed})
      AND m.direction = 'inbound'
      AND NOT EXISTS (
        SELECT 1 FROM live_turns lt
        WHERE 'conversation:' || lt.conversation_id = m.conversation_id
          AND lt.state NOT IN ('completed', 'failed', 'timed_out')
      )
      AND m.created_at > COALESCE(
        (SELECT max(COALESCE(lt2.ended_at, lt2.updated_at, lt2.created_at))
         FROM live_turns lt2
         WHERE 'conversation:' || lt2.conversation_id = m.conversation_id),
        '-infinity'::timestamptz
      )
    ORDER BY m.created_at ASC
    LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    conversationJid: row.conversation_id.replace(/^conversation:/, ''),
    threadId: null,
    waitingSince: String(row.waiting_since),
    ageSeconds: Number(row.age_seconds) || 0,
  };
}
