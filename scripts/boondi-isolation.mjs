#!/usr/bin/env node
// Multi-user concurrency + BLEED guard.
//
// The bug class this protects against (already fixed once): under concurrent load,
// one customer's chat content leaking into another customer's reply, or a reply
// being routed to the wrong conversation. This drives several DISTINCTIVE users at
// the SAME TIME, then proves each user's content stayed in its own conversation.
//
// How it judges:
//   1. liveness  — every user got at least one reply, under its OWN conversation.
//   2. no bleed  — no user's distinctive signature appears in any OTHER user's
//                  reply (scanned in gantry.messages, this run only).
//
// Prereqs: same dev stack as boondi-regression (GANTRY_FLOW_LOG=1,
// GANTRY_OUTBOUND_DRYRUN=1 so replies persist, every ISOLATION phone in
// GANTRY_TEST_OPERATOR_PHONE). Needs GANTRY_DATABASE_URL for the scan.
//
// Usage: node scripts/boondi-isolation.mjs
import pg from 'pg';
import { sendWebhook } from './lib/webhook.mjs';
import { ISOLATION_PHONES } from './lib/phones.mjs';
import { gantryEnv, schemaEnv } from './lib/runtime-env.mjs';

const CONN = gantryEnv('GANTRY_DATABASE_URL') || gantryEnv('BOONDI_CRM_DATABASE_URL');
const SCHEMA = schemaEnv('GANTRY_DB_SCHEMA', 'gantry');
const SETTLE_MS = Number(process.env.ISOLATION_SETTLE_MS || 60_000);
// Keep concurrency within host capacity (warm sessions stall the group loop past ~5).
const N = Math.min(Number(process.env.ISOLATION_USERS || 4), ISOLATION_PHONES.length);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Distinctive users: each message carries content unlikely to recur in another
// chat, with a regex signature owned by exactly that phone. A non-owner reply
// matching a signature is high-confidence cross-conversation bleed.
const USERS = [
  { msg: "My daughter's wedding is next month — I need exactly 250 favour boxes for the guests.",
    re: /250 (?:favour |gift )?box|daughter(?:'s)? wedding/i, label: 'wedding/250-boxes' },
  { msg: 'Following up on order #90627 — it was the Choco Butterscotch Barks, has it shipped?',
    re: /#?90627|choco butterscotch bark/i, label: 'order#90627' },
  { msg: 'Before I order: I am severely allergic to nuts, it is life-threatening. Anything safe?',
    re: /severely allergic|life[- ]threatening|anaphyla/i, label: 'severe-nut-allergy' },
  { msg: 'Corporate Diwali gifting for Acme Corp — 500 boxes, pan-India, reach me at priya@finbox.in.',
    re: /priya@finbox\.in|acme corp|500 box/i, label: 'acme/priya@finbox.in' },
  { msg: 'I need exactly 37 pieces of gulab jamun for a temple event this Friday.',
    re: /37 (?:piece|gulab)|temple event/i, label: '37-gulab-jamun/temple' },
  { msg: 'Sending one box of motichoor laddoo to my grandmother in Jodhpur for Teej.',
    re: /jodhpur|teej|motichoor laddoo/i, label: 'jodhpur/teej' },
].slice(0, N);

const phones = ISOLATION_PHONES.slice(0, N);

async function repliesFor(client, phone, since) {
  const r = await client.query(
    `select mp.payload_json->>'text' as text
       from ${SCHEMA}.messages m
       join ${SCHEMA}.message_parts mp on mp.message_id = m.id
      where m.conversation_id = $1 and m.direction = 'outbound'
        and mp.kind = 'text' and m.created_at >= $2
      order by m.created_at asc`,
    [`conversation:wa:${phone}`, since],
  );
  return r.rows.map((x) => x.text).filter(Boolean).filter((t) => !/Started a fresh session/i.test(t));
}

async function main() {
  if (!CONN) {
    console.error('Set GANTRY_DATABASE_URL (to scan the transcript for bleed).');
    process.exit(2);
  }
  const since = new Date().toISOString();
  console.error(`Driving ${N} distinctive users concurrently from ${since}…`);

  // Reset each lane, then fire all the distinctive messages CONCURRENTLY.
  await Promise.all(phones.map((p) => sendWebhook({ text: '/new', from: p })));
  await sleep(1500);
  const acks = await Promise.all(
    USERS.map((u, i) => sendWebhook({ text: u.msg, from: phones[i] })),
  );
  acks.forEach((a, i) => {
    if (!a.ok) console.error(`  ⚠️ user ${i} (${phones[i]}) webhook HTTP ${a.status}`);
  });

  console.error(`Sent. Settling ${Math.round(SETTLE_MS / 1000)}s for concurrent replies to land…`);
  await sleep(SETTLE_MS);

  const client = new pg.Client({ connectionString: CONN });
  await client.connect();
  const byPhone = {};
  for (const p of phones) byPhone[p] = await repliesFor(client, p, since);
  await client.end();

  const failures = [];

  // 1) Liveness: every user got a reply under its own conversation.
  phones.forEach((p, i) => {
    if (byPhone[p].length === 0) failures.push(`user ${i} (${p}, ${USERS[i].label}): NO reply persisted — dropped under concurrent load?`);
  });

  // 2) Bleed: no user's signature appears in another user's replies.
  for (let owner = 0; owner < USERS.length; owner += 1) {
    for (let other = 0; other < phones.length; other += 1) {
      if (other === owner) continue;
      for (const text of byPhone[phones[other]]) {
        const m = text.match(USERS[owner].re);
        if (m) {
          failures.push(
            `BLEED: "${USERS[owner].label}" (owner ${phones[owner]}) appeared in ${phones[other]}'s reply: …${text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\n/g, ' ')}…`,
          );
        }
      }
    }
  }

  console.log('\n=== reply counts (this run) ===');
  phones.forEach((p, i) => console.log(`  ${p}  ${byPhone[p].length} replies  (${USERS[i].label})`));

  const ok = failures.length === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  isolation: ${ok ? 'each chat stayed in its own conversation, no bleed' : `${failures.length} problem(s)`}`);
  if (!ok) for (const f of failures) console.log(`  -> ${f}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
