// Reset test-phone data so a regression run is deterministic: delete each test
// phone's conversation (cascades to messages/parts), its agent sessions/runs/jobs/
// events, its opportunity rows + digest cursor + memory; then seed the returning
// persona with a prior open lead + chat context. Schema-qualified for the
// per-opportunity model. Talks only to the shared DB.
import { randomUUID } from 'node:crypto';
import { schemaEnv } from './runtime-env.mjs';

function assertResetTarget(client, gantrySchema, crmSchema) {
  const p = client.connectionParameters || {};
  const host = p.host || '';
  const isLocal =
    host === '' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.startsWith('/');
  if (!isLocal && process.env.BOONDI_ALLOW_DB_RESET !== '1') {
    throw new Error(
      `refusing to reset non-local database host ${host}; set BOONDI_ALLOW_DB_RESET=1 if this is an intentional test target`,
    );
  }
  console.error(
    `reset target database=${p.database || '(unknown)'} host=${host || '(default)'} schemas=${gantrySchema},${crmSchema}`,
  );
}

export async function resetTestData(
  client,
  phones,
  {
    gantrySchema = schemaEnv('GANTRY_DB_SCHEMA', 'gantry'),
    crmSchema = schemaEnv('BOONDI_CRM_DB_SCHEMA', 'boondi_crm'),
  } = {},
) {
  const convIds = phones.map((p) => `conversation:wa:${p}`);
  assertResetTarget(client, gantrySchema, crmSchema);
  await client.query(`set lock_timeout = '10s'`);
  await client.query(`set statement_timeout = '30s'`);

  await client.query(`delete from ${crmSchema}.boondi_business_records where phone = any($1)`, [phones]);
  await client.query(`delete from ${crmSchema}.boondi_digest_cursor where conversation_id = any($1)`, [convIds]).catch(() => {});
  await client.query(`delete from ${gantrySchema}.memory_items where user_id = any($1)`, [phones]).catch(() => {});
  // Digests reference sessions (FK); drop them before the sessions.
  await client
    .query(`delete from ${gantrySchema}.agent_session_digests where agent_session_id in (select id from ${gantrySchema}.agent_sessions where conversation_id = any($1))`, [convIds])
    .catch(() => {});
  // These have NO ACTION / SET NULL FKs to conversations, so clear them (children
  // before parents) before deleting the conversation.
  for (const tbl of ['runtime_events', 'jobs', 'agent_runs', 'agent_sessions']) {
    await client.query(`delete from ${gantrySchema}.${tbl} where conversation_id = any($1)`, [convIds]).catch((e) => {
      console.error(`  [reset] ${gantrySchema}.${tbl}: ${e.message}`);
    });
  }
  // Conversations cascade to messages -> message_parts and participants.
  await client.query(`delete from ${gantrySchema}.conversations where id = any($1)`, [convIds]);
}

// The returning-customer scenario needs PRIOR context (so a bare "hi" reaches the
// agent and triggers get_open_records) plus an open lead to recognise.
export async function seedReturning(
  client,
  phone,
  {
    gantrySchema = schemaEnv('GANTRY_DB_SCHEMA', 'gantry'),
    crmSchema = schemaEnv('BOONDI_CRM_DB_SCHEMA', 'boondi_crm'),
  } = {},
) {
  const APP_ID = 'default';
  const PROVIDER = 'interakt';
  const PROVIDER_CONN = 'channel-providerConnection:default:interakt';
  const conv = `conversation:wa:${phone}`;
  const dayMs = 24 * 60 * 60 * 1000;
  const tEarlier = new Date(Date.now() - 3 * dayMs).toISOString();
  const tReply = new Date(Date.now() - 3 * dayMs + 60_000).toISOString();

  await client.query(
    `insert into ${gantrySchema}.conversations
       (id, app_id, provider_connection_id, external_ref_json, kind, title, status, created_at, updated_at)
     values ($1,$2,$3,$4,'direct',$5,'active',$6,$6)`,
    [
      conv, APP_ID, PROVIDER_CONN,
      JSON.stringify({ kind: 'conversation', value: phone, jid: `wa:${phone}`, providerId: PROVIDER, externalConversationId: phone, isGroup: false }),
      'Aarav (Acme Corp)', tEarlier,
    ],
  );
  await client.query(
    `insert into ${crmSchema}.boondi_business_records
       (id, phone, customer_name, conversation_id, status, intent_category,
        occasion, quantity, quantity_raw, buyer_type, summary_brief, source, score, band)
     values ($1,$2,$3,$4,'lead','corporate','Diwali',300,'around 300','employee_gifting',
        'Returning: ~300 Diwali boxes for the team (seeded for recognition test)','agent',77,'P2')`,
    [`bcr_${randomUUID()}`, phone, 'Aarav (Acme Corp)', conv],
  );
  const seedMsg = async (suffix, direction, trust, sender, deliveryStatus, ts, text) => {
    const id = `message:wa:${phone}:seed:${suffix}`;
    await client.query(
      `insert into ${gantrySchema}.messages
         (id, app_id, provider, provider_connection_id, conversation_id, direction,
          sender_user_id, sender_display_name, trust, created_at, received_at, delivery_status, delivered_at, external_ref_json)
       values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,$9,$10,$11,$12)`,
      [id, APP_ID, PROVIDER, PROVIDER_CONN, conv, direction, sender, trust, ts, deliveryStatus, deliveryStatus ? ts : null, JSON.stringify({ is_from_me: direction !== 'inbound', is_bot_message: direction !== 'inbound' })],
    );
    await client.query(`insert into ${gantrySchema}.message_parts (message_id, ordinal, kind, payload_json) values ($1,0,'text',$2)`, [id, JSON.stringify({ kind: 'text', text })]);
  };
  await seedMsg('in', 'inbound', 'trusted', 'Aarav (Acme Corp)', null, tEarlier, 'Hi, I am looking at Diwali gift boxes for our team — around 300 boxes.');
  await seedMsg('out', 'outbound', 'system', 'Boondi', 'sent', tReply, 'How lovely — 300 Diwali boxes for the team! Whenever you are ready, share your budget per box and the timeline and I will pull together the best options.');
}
