// Async assertions for the background CRM extractor's output.
//
// Capture is no longer a live tool call: the agent just chats, the session ends, a
// session-end digest forms, and the boondi-crm watcher extracts opportunity rows
// into boondi_business_records. So a CRM scenario is checked by POLLING the DB
// after the session is forced to end (/new), not by reading the flow log. A phone
// can own MANY rows (per-opportunity model); an expectation matches if SOME row
// satisfies all its fields.
import pg from 'pg';
import { gantryEnv, schemaEnv } from './runtime-env.mjs';

const { Client } = pg;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function dbConn() {
  return gantryEnv('BOONDI_CRM_DATABASE_URL') || gantryEnv('DATABASE_URL');
}

export async function openClient(
  connectionString = dbConn(),
  schema = schemaEnv('BOONDI_CRM_DB_SCHEMA', 'boondi_crm'),
) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  await client.query(`set search_path to ${schema}`);
  return client;
}

export async function closeClient(client) {
  await client.end().catch(() => undefined);
}

// All opportunity rows for a phone, newest first.
export async function recordsForPhone(client, phone) {
  const res = await client.query(
    `select status, intent_category, buyer_type, location_scope, customisation,
            score, band, source, occasion, quantity, needs_review
       from boondi_business_records where phone = $1 order by updated_at desc`,
    [phone],
  );
  return res.rows;
}

export async function digestCursorAtOrAfter(client, conversationId, sinceIso) {
  const res = await client.query(
    `select last_digest_id, last_digest_at, checked_at
       from boondi_digest_cursor
      where conversation_id = $1 and last_digest_at >= $2::timestamptz
      order by last_digest_at desc
      limit 1`,
    [conversationId, sinceIso],
  );
  return res.rows[0] || null;
}

// Field-by-field check of ONE row against an expectation. "query" is satisfied by
// query OR qualifying (both pre-lead, shown together under the dashboard's Queries).
export function matchFailures(rec, exp) {
  const f = [];
  if (exp.status) {
    const ok =
      exp.status === 'query'
        ? rec.status === 'query' || rec.status === 'qualifying'
        : rec.status === exp.status;
    if (!ok) f.push(`status ${exp.status}, got ${rec.status}`);
  }
  if (exp.intentCategory && rec.intent_category !== exp.intentCategory)
    f.push(`intent ${exp.intentCategory}, got ${rec.intent_category}`);
  if (exp.buyerType && rec.buyer_type !== exp.buyerType)
    f.push(`buyerType ${exp.buyerType}, got ${rec.buyer_type}`);
  if (exp.locationScope && rec.location_scope !== exp.locationScope)
    f.push(`locationScope ${exp.locationScope}, got ${rec.location_scope}`);
  if (exp.customisation && rec.customisation !== exp.customisation)
    f.push(`customisation ${exp.customisation}, got ${rec.customisation}`);
  if (exp.source && rec.source !== exp.source)
    f.push(`source ${exp.source}, got ${rec.source}`);
  if (exp.scored && typeof rec.score !== 'number') f.push('expected a numeric score');
  if (exp.minScore != null && !(rec.score >= exp.minScore))
    f.push(`score >= ${exp.minScore}, got ${rec.score}`);
  return f;
}

// Assert expectRecord against all of a phone's rows. `absent` → expect none;
// otherwise pass if SOME row matches every expected field.
export function assertRecord(records, expectRecord) {
  const exp = expectRecord || {};
  if (exp.absent) {
    return records.length
      ? [`expected NO opportunity row, found ${records.length} (status=${records.map((r) => r.status).join(',')})`]
      : [];
  }
  if (records.length === 0) return ['expected an opportunity row, none found'];
  const perRow = records.map((r) => matchFailures(r, exp));
  if (perRow.some((fs) => fs.length === 0)) return [];
  const best = perRow.reduce((a, b) => (b.length < a.length ? b : a));
  return [`no row matched ${JSON.stringify(exp)} — closest: ${best.join('; ')}`];
}

// Poll the DB until the expectation is satisfied (or, for `absent`, until something
// appears or the window elapses). The window must cover: digest-on-/new + one
// watcher poll + the extractor LLM call — so keep BOONDI_CRM_RECONCILE_INTERVAL_MS
// short for the run (the setup does this).
export async function waitForRecord(
  client,
  phone,
  expectRecord,
  { timeoutMs = 90_000, intervalMs = 4_000, conversationId = null, processedAfter = null } = {},
) {
  const exp = expectRecord || {};
  const deadline = Date.now() + timeoutMs;
  let records = await recordsForPhone(client, phone);
  let processed = false;
  while (Date.now() < deadline) {
    records = await recordsForPhone(client, phone);
    if (exp.absent) {
      if (records.length) break; // a row appeared → fail fast
      if (conversationId && processedAfter) {
        processed = Boolean(await digestCursorAtOrAfter(client, conversationId, processedAfter));
        if (processed) break; // absence is meaningful only after this digest was consumed
      }
    } else if (assertRecord(records, exp).length === 0) {
      break; // satisfied
    }
    await sleep(intervalMs);
  }
  const failures = assertRecord(records, expectRecord);
  if (exp.absent && conversationId && processedAfter && !processed && records.length === 0) {
    failures.push(`expected CRM digest cursor for ${conversationId} at/after ${processedAfter}, none seen`);
  }
  return { records, failures };
}
