// Read-only access to Gantry's DURABLE transcript for the watcher.
// boondi-crm reads Gantry's messages — a one-way dependency; Gantry never
// depends on boondi-crm. Gantry's transcript tables are EXPLICITLY
// schema-qualified (the CRM's search_path is its own boondi_crm); these
// tables resolve in boondi_crm.

import type { Pool } from 'pg';

export interface TranscriptMessage {
  role: 'customer' | 'assistant';
  text: string;
}

const TRANSCRIPT_CONTROL_COMMAND_RE =
  /^\/(?:digest-session|extract-memory-facts|extract-leads-queries)(?:\s|$)/i;

// conversation id is "conversation:wa:<digits>"; the bare digits are the customer
// key used everywhere else (records.phone, memory_items.user_id).
export function phoneFromConversationId(
  conversationId: string,
): string | undefined {
  const match = conversationId.match(/wa:(\d+)/);
  return match ? match[1] : undefined;
}

function isTranscriptControlCommand(text: string): boolean {
  return TRANSCRIPT_CONTROL_COMMAND_RE.test(text);
}

// The conversation's text transcript, oldest→newest, role-tagged by direction.
// The window is the NEWEST `LIMIT` rows (inner DESC + LIMIT), re-sorted
// ascending for the prompt. Taking the oldest rows here (previous behavior)
// made >80-message conversations extract from stale history and miss the very
// turns that triggered extraction; the newest window is safe because earlier
// content is already banked in boondi_business_records and re-enters every
// prompt via the open-opportunities list.
// (created_at DESC, id DESC) mirrors core's canonical message ordering and its idx_messages_conversation_recent index, so ties cut deterministically at the window edge.
export function transcriptSql(gantrySchema: string): string {
  return `SELECT t.direction, t.text
       FROM (SELECT m.created_at, m.id, p.ordinal, m.direction, p.payload_json->>'text' AS text
               FROM ${gantrySchema}.messages m
               JOIN ${gantrySchema}.message_parts p ON p.message_id = m.id AND p.kind = 'text'
              WHERE m.conversation_id = $1
              ORDER BY m.created_at DESC, m.id DESC, p.ordinal DESC
              LIMIT $2) t
      ORDER BY t.created_at ASC, t.id ASC, t.ordinal ASC`;
}

export async function loadTranscript(
  pool: Pool,
  gantrySchema: string,
  conversationId: string,
  maxMessages = 80,
): Promise<TranscriptMessage[]> {
  const res = await pool.query(transcriptSql(gantrySchema), [
    conversationId,
    maxMessages,
  ]);
  const out: TranscriptMessage[] = [];
  let skipAssistantAcknowledgement = false;
  for (const row of res.rows) {
    const text = (row.text as string | null)?.trim();
    if (!text) continue;
    const isCustomer = row.direction === 'inbound';
    if (isCustomer && isTranscriptControlCommand(text)) {
      skipAssistantAcknowledgement = true;
      continue;
    }
    if (!isCustomer && skipAssistantAcknowledgement) {
      skipAssistantAcknowledgement = false;
      continue;
    }
    if (isCustomer) skipAssistantAcknowledgement = false;
    out.push({
      role: isCustomer ? 'customer' : 'assistant',
      text,
    });
  }
  return out;
}
