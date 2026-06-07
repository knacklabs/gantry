#!/usr/bin/env node
// Boondi end-to-end regression. ONE command proves Boondi is healthy across the
// three things it must do, reporting PASS/FAIL per group:
//
//   conversation — natural behaviour: persona/tone, output discipline, language
//                  mirroring, honesty rules, staying on-topic (guardrail).
//   shopify      — calls the Shopify MCP correctly for orders/products AND only
//                  ever reveals the customer's OWN data (privacy DENY).
//   crm          — an orders/gifting chat produces the right queries & leads
//                  (checked in boondi_business_records AFTER the digest fires).
//
// The conversation+shopify groups are judged synchronously from the runtime
// flow-log; the crm group is judged asynchronously from the DB (capture is
// background now), by ending the session (/new) and polling for the rows.
//
// Prereqs (the setup brings these up): dev servers in watch mode with
//   GANTRY_FLOW_LOG=1  GANTRY_OUTBOUND_DRYRUN=1
//   GANTRY_TEST_OPERATOR_PHONE=<all test phones>  (see lib/phones.mjs)
//   GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633
//   BOONDI_CRM_RECONCILE_INTERVAL_MS=<short, e.g. 10000>  (so the crm group is fast)
// and Gantry stdout tee'd to GANTRY_DEV_LOG (default /tmp/gantry-dev.log).
//
// Usage:
//   node scripts/boondi-regression.mjs                 # all groups
//   node scripts/boondi-regression.mjs conversation    # one group
//   node scripts/boondi-regression.mjs shopify crm
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendWebhook } from './lib/webhook.mjs';
import { ALL_TEST_PHONES, LANE_PHONES, RETURNING_PHONE } from './lib/phones.mjs';
import {
  openClient,
  closeClient,
  recordsForPhone,
  digestCursorAtOrAfter,
  assertRecord,
  matchFailures,
} from './lib/crm-db.mjs';
import { resetTestData, seedReturning } from './lib/reset.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = process.env.GANTRY_DEV_LOG || '/tmp/gantry-dev.log';
const SCENARIOS_PATH =
  process.env.BOONDI_SCENARIOS || path.join(HERE, 'boondi-scenarios.json');
const ALL_GROUPS = ['conversation', 'shopify', 'crm'];
const REQUESTED_GROUPS = process.argv.slice(2);
const BAD_GROUPS = REQUESTED_GROUPS.filter((a) => !ALL_GROUPS.includes(a));
if (BAD_GROUPS.length) {
  console.error(`Unknown group(s): ${BAD_GROUPS.join(', ')}. Valid groups: ${ALL_GROUPS.join(', ')}`);
  process.exit(2);
}
const GROUP_FILTER = REQUESTED_GROUPS;

const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 120_000);
const SETTLE_MS = Number(process.env.SETTLE_MS || 700);
const RESET_WAIT_TIMEOUT_MS = Number(process.env.RESET_WAIT_TIMEOUT_MS || 20_000);
const QUIESCE_QUIET_MS = Number(process.env.QUIESCE_QUIET_MS || 6000);
const QUIESCE_MAX_MS = Number(process.env.QUIESCE_MAX_MS || 60000);
const LLM_OUTBOUND_GRACE_MS = Number(process.env.LLM_OUTBOUND_GRACE_MS || 4000);
// crm group: after /new forces the digest, how long to poll boondi_business_records.
// Generous because capture is background + serial (~20s/extraction); the crm group
// runs first (empty extractor queue) so this window only needs to cover one scenario's
// own digest, not a cross-group backlog.
const CRM_WAIT_MS = Number(process.env.CRM_WAIT_MS || 180_000);
const CRM_ABSENT_WAIT_MS = Number(process.env.CRM_ABSENT_WAIT_MS || 60_000);
const CRM_POLL_MS = Number(process.env.CRM_POLL_MS || 4_000);
// crm scenarios run on their own persona phones; cap how many at once (host load).
const CRM_CONCURRENCY = Number(process.env.CRM_CONCURRENCY || 3);

const RESET_REPLY_RE = /Started a fresh session/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);
const logSize = () => {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return 0;
  }
};

// ── flow-log parsing (verbatim from the proven runner) ──────────────────────
function readSlice(fromOffset) {
  const size = logSize();
  if (size <= fromOffset) return '';
  const fd = fs.openSync(LOG, 'r');
  try {
    const buf = Buffer.alloc(size - fromOffset);
    fs.readSync(fd, buf, 0, buf.length, fromOffset);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseFlowEvents(text, chatJid) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.includes('"flow":')) continue;
    const brace = line.indexOf('{');
    if (brace === -1) continue;
    let obj;
    try {
      obj = JSON.parse(line.slice(brace));
    } catch {
      continue;
    }
    if (obj && typeof obj.flow !== 'string' && obj.context && typeof obj.context.flow === 'string') {
      obj = obj.context;
    }
    if (!obj || typeof obj.flow !== 'string') continue;
    const eventJid = obj.jid ?? obj.chatJid;
    if (chatJid && eventJid && eventJid !== chatJid) continue;
    events.push(obj);
  }
  return events;
}

async function waitForTurn(fromOffset, chatJid) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const settleAndSnapshot = async () => {
    await sleep(SETTLE_MS);
    return parseFlowEvents(readSlice(fromOffset), chatJid);
  };
  const isOutbound = (e) => e.flow === 'outbound' && !RESET_REPLY_RE.test(e.reply || '');
  let firstLlmAt = null;
  while (Date.now() < deadline) {
    const events = parseFlowEvents(readSlice(fromOffset), chatJid);
    if (events.some(isOutbound)) return settleAndSnapshot();
    if (events.some((e) => e.flow === 'guardrail' && e.guardrailDecision)) return settleAndSnapshot();
    if (events.some((e) => e.flow === 'llm.output')) {
      if (firstLlmAt === null) firstLlmAt = Date.now();
      else if (Date.now() - firstLlmAt >= LLM_OUTBOUND_GRACE_MS) return settleAndSnapshot();
    }
    await sleep(1_000);
  }
  return parseFlowEvents(readSlice(fromOffset), chatJid);
}

async function waitForReset(fromOffset, chatJid) {
  const deadline = Date.now() + RESET_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const events = parseFlowEvents(readSlice(fromOffset), chatJid);
    if (events.some((e) => e.flow === 'outbound' && RESET_REPLY_RE.test(e.reply || ''))) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for /new reset reply for ${chatJid}`);
}

async function waitForQuiescence(fromOffset, chatJid) {
  const deadline = Date.now() + QUIESCE_MAX_MS;
  let lastCount = -1;
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const n = parseFlowEvents(readSlice(fromOffset), chatJid).length;
    if (n !== lastCount) {
      lastCount = n;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= QUIESCE_QUIET_MS) {
      return;
    }
    await sleep(500);
  }
}

// ── assertion vocabulary (live-flow; verbatim from the proven runner) ───────
const PRIVACY_DENY_RE =
  /ARG_VS_HEADER_MISMATCH|PRIVACY_GUARD|CUSTOMER_ID_MISMATCH|IDENTITY_MISMATCH|only check details linked to|phone number you are messaging from|does(?:n't| not) match that number|your own (?:account|number|phone)/i;
function responseText(ev) {
  const parts = ev?.result?.content;
  if (Array.isArray(parts)) return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  return JSON.stringify(ev?.result ?? {});
}
const isPrivacyDenyResponse = (ev) => ev?.result?.isError === true && PRIVACY_DENY_RE.test(responseText(ev));
const replyRefusesAccess = (text) =>
  typeof text === 'string' &&
  /only (?:share|check|look up|pull up|access|help).*(?:own|your)|can'?t (?:share|look up|access|pull up|do) that|not able to (?:share|look up|access|pull up)|does(?:n't| not) match|linked to (?:your|the).*number/i.test(text);

const HINGLISH_MARKER_RE =
  /\b(aap|aapka|aapki|aapko|hai|hain|kya|kyun|kyon|nahi|nahin|mera|meri|mujhe|kaise|kaisa|kaisi|chahiye|karna|karein|karo|kijiye|kijiyega|dhanyavaad|namaste|shukriya|theek|thik|achha|acha|accha|haan|kitna|kitni|kitne|daam|paisa|paise|abhi|thoda|thodi|bahut|raha|rahi|rahe|hoon|milega|milegi|milenge|bata|batao|bataiye|samajh|wapas|jaldi|kripya|krpya)\b/gi;
function detectReplyLanguage(text) {
  if (!text || !text.trim()) return 'none';
  if (/[ऀ-ॿ]/.test(text)) return 'hindi';
  const markers = text.match(HINGLISH_MARKER_RE) || [];
  return markers.length >= 2 ? 'hinglish' : 'english';
}

const NARRATION_RE =
  /(let me (?:just )?(?:look(?: (?:that|it|this))? up|check|pull(?: (?:that|it|this))? up|pull that|pull your|see if|find that|search)|i['’]?ll (?:look(?: (?:that|it|this))? up|check|pull(?: (?:that|it|this))? up|pull that|pull your|fetch|search)|i['’]?ll pull\b|now i['’]?ll\b|one moment|i have the tools|got your account|i found your account|\blooking (?:up|that up|it up)\b|\bsearching\b|pulling (?:that|this|it|your)\s*\w*\s*up|checking (?:the catalogue|that|your)\b|fetching\b|on it[!.])/i;
const BANNED_RE =
  /\bkindly\b|please be informed|as per (?:your query|policy)|apologise for the inconvenience|sure,? no problem|i ?am just a bot|i['’]?m just a bot/i;
const LEAK_RE =
  /\bshopify\b|\bmcp\b|\bgantry\b|knowledge base|admin panel|x-caller-identity|\b(?:401|403|429|503)\b/i;

// Evaluate a turn's (or scenario's) live-flow events against an `expect` block.
function evaluate(events, expect, cfg) {
  const by = (f) => events.filter((e) => e.flow === f);
  const guardrail = events.find((e) => e.flow === 'guardrail');
  const mcpReq = by('mcp.request');
  const mcpErr = by('mcp.error');
  const mcpResp = by('mcp.response');
  const outbound = by('outbound');
  const llmOut = events.find((e) => e.flow === 'llm.output');
  const exp = expect || {};
  const failures = [];

  const customerReplies = outbound
    .map((o) => o.reply)
    .filter((t) => typeof t === 'string' && t.trim() && !RESET_REPLY_RE.test(t));
  const replyText = (
    customerReplies.length
      ? customerReplies
      : [llmOut?.reply].filter((t) => typeof t === 'string' && t.trim())
  ).join('\n');
  const replyLang = detectReplyLanguage(replyText);
  const mcpPrivacyDenies = [
    ...mcpErr.filter((e) => PRIVACY_DENY_RE.test(e.error || '')),
    ...mcpResp.filter(isPrivacyDenyResponse),
  ];

  if (exp.guardrail && guardrail?.guardrailDecision !== exp.guardrail) {
    failures.push(`expected guardrail "${exp.guardrail}", got "${guardrail?.guardrailDecision ?? 'none'}"`);
  }
  // A greeting must be WELCOMED, not rejected — accept either the first-contact
  // canned greeting OR the returning-customer path (both are correct); only a
  // scope-rejection / block / abuse decision is a failure.
  if (exp.greeting) {
    const d = guardrail?.guardrailDecision;
    if (d && /reject|block|abuse/i.test(d)) {
      failures.push(`expected a warm greeting, but the turn was guardrail "${d}"`);
    } else if (!replyText.trim()) {
      failures.push('expected a greeting reply, none seen');
    }
  }
  if (exp.noGuardrailBlock) {
    const blocked = events.find((e) => e.flow === 'guardrail' && e.guardrailDecision);
    if (blocked) failures.push(`expected the turn to reach the agent, but the guardrail blocked it (${blocked.guardrailDecision}: ${blocked.guardrailReason ?? ''})`);
  }
  if (exp.mcp && mcpReq.length === 0) failures.push('expected an MCP call, none seen');
  if (exp.allow && mcpErr.length > 0) {
    failures.push(`expected ALLOW but MCP errored: ${mcpErr.map((e) => e.error).join('; ')}`);
  }
  if (exp.deny) {
    const replyRefused = customerReplies.some(replyRefusesAccess);
    if (mcpPrivacyDenies.length === 0 && !replyRefused) {
      failures.push('expected a privacy DENY, none seen (no MCP privacy guard, no refusal in reply)');
    }
  }
  if (exp.replyLang && replyLang !== exp.replyLang) {
    failures.push(`expected reply language "${exp.replyLang}", got "${replyLang}"`);
  }
  if (replyText.trim()) {
    if (exp.noNarration) {
      const opener = (replyText.match(/[^.!?\n]*[.!?]+/g) || [replyText]).slice(0, 2).join(' ');
      const m = opener.match(NARRATION_RE);
      if (m) failures.push(`reply opens by narrating the lookup (banned opener): "${m[0]}"`);
    }
    if (exp.noBanned) {
      const m = replyText.match(BANNED_RE);
      if (m) failures.push(`reply uses banned corporate phrasing: "${m[0]}"`);
    }
    if (exp.noLeak) {
      const m = replyText.match(LEAK_RE);
      if (m) failures.push(`reply leaks an internal system/error code: "${m[0]}"`);
    }
  }
  if (exp.replyMustMatch) {
    for (const p of [].concat(exp.replyMustMatch)) {
      if (!new RegExp(p, 'i').test(replyText)) failures.push(`reply must match /${p}/i but did not`);
    }
  }
  if (exp.replyMustNotMatch) {
    for (const p of [].concat(exp.replyMustNotMatch)) {
      const m = replyText.match(new RegExp(p, 'i'));
      if (m) failures.push(`reply must NOT match /${p}/i but did: "${m[0]}"`);
    }
  }
  // ISOLATION invariant: every outbound for this turn must target this lane's OWN
  // number — a reply must never be routed to another conversation.
  for (const o of outbound) {
    if (o.jid !== `wa:${cfg.lane}`) failures.push(`ISOLATION: outbound jid "${o.jid}" is not wa:${cfg.lane}`);
  }
  return { guardrail, mcpReq, mcpErr, mcpResp, mcpPrivacyDenies, outbound, llmOut, replyLang, failures };
}

// ── CRM async assertion (DB, after the digest) ──────────────────────────────
// One expected opportunity sub-record matches some row: standard fields via
// matchFailures + occasionMatch (regex on occasion) + exact quantity.
function rowMatchesExpected(rec, exp) {
  if (exp.occasionMatch && !new RegExp(exp.occasionMatch, 'i').test(rec.occasion || '')) return false;
  if (exp.quantity != null && rec.quantity !== exp.quantity) return false;
  return matchFailures(rec, exp).length === 0;
}
function crmFailures(scenario, records) {
  const fails = [];
  if (scenario.expectRecord) fails.push(...assertRecord(records, scenario.expectRecord));
  if (typeof scenario.expectMinRecords === 'number' && records.length < scenario.expectMinRecords) {
    fails.push(`expected >= ${scenario.expectMinRecords} opportunity rows, got ${records.length}`);
  }
  if (Array.isArray(scenario.expectRecords)) {
    for (const exp of scenario.expectRecords) {
      if (!records.some((r) => rowMatchesExpected(r, exp))) {
        fails.push(`no opportunity row matched ${JSON.stringify(exp)}`);
      }
    }
  }
  return fails;
}
async function crmDbCheck(scenario, phone, digestAfter) {
  const absent = scenario.expectRecord?.absent === true;
  const timeout = absent ? CRM_ABSENT_WAIT_MS : CRM_WAIT_MS;
  const conversationId = `conversation:wa:${phone}`;
  let client;
  try {
    client = await openClient();
  } catch (err) {
    return { records: [], failures: [`crm DB unavailable: ${err.message}`] };
  }
  try {
    const deadline = Date.now() + timeout;
    let records = await recordsForPhone(client, phone);
    let digestProcessed = false;
    while (Date.now() < deadline) {
      records = await recordsForPhone(client, phone);
      if (absent) {
        if (records.length) break; // something appeared → will fail
        digestProcessed = Boolean(await digestCursorAtOrAfter(client, conversationId, digestAfter));
        if (digestProcessed) break; // absence is meaningful only after this digest is consumed
      } else if (crmFailures(scenario, records).length === 0) {
        break; // satisfied
      }
      await sleep(CRM_POLL_MS);
    }
    const failures = crmFailures(scenario, records);
    if (absent && !digestProcessed && records.length === 0) {
      failures.push(`expected digest cursor for ${conversationId} at/after ${digestAfter}, none seen`);
    }
    return { records, failures };
  } finally {
    await closeClient(client);
  }
}

// ── scenario execution ──────────────────────────────────────────────────────
async function runScenario(scenario, lanePhone) {
  const lane = scenario.phone || lanePhone;
  const chatJid = `wa:${lane}`;
  const cfg = { lane };
  const resetSession = async (label) => {
    const startedAt = new Date().toISOString();
    const offset = logSize();
    const sent = await sendWebhook({ text: '/new', from: lane });
    if (!sent.ok) throw new Error(`${label} /new rejected (HTTP ${sent.status}): ${sent.response}`);
    await waitForReset(offset, chatJid);
    return startedAt;
  };

  // Fresh session before turn 1.
  try {
    await resetSession('setup');
  } catch (err) {
    return { scenario, turns: [], turnsEvents: [], aborted: `reset failed: ${err.message}`, cfg, crm: null };
  }

  const turns = scenario.turns.map((t) => (typeof t === 'string' ? { text: t } : t));
  const turnsEvents = [];
  let aborted = null;
  for (let ti = 0; ti < turns.length; ti += 1) {
    const offset = logSize();
    const sent = await sendWebhook({ text: turns[ti].text, from: lane });
    if (!sent.ok) {
      aborted = `webhook rejected (HTTP ${sent.status}): ${sent.response}`;
      break;
    }
    turnsEvents.push(await waitForTurn(offset, chatJid));
    if (ti < turns.length - 1) await waitForQuiescence(offset, chatJid);
  }

  // End the session: for crm this also forces the session-end digest the
  // extractor consumes; for the other groups it just frees the warm session.
  let digestAfter = null;
  try {
    digestAfter = await resetSession('teardown');
  } catch (err) {
    aborted = aborted ?? `teardown reset failed: ${err.message}`;
  }

  // crm group: poll the DB now that the digest has been triggered.
  let crm = null;
  if (scenario.group === 'crm' && !aborted) {
    crm = await crmDbCheck(scenario, lane, digestAfter);
  }
  return { scenario, turns, turnsEvents, aborted, cfg, crm };
}

function reportScenario(r) {
  const { scenario, turns, turnsEvents, aborted, cfg, crm } = r;
  if (aborted) {
    console.log(`\nFAIL  [${scenario.group}] ${scenario.name}\n  -> ${aborted}`);
    return false;
  }
  const failures = [];
  // Live-flow expectations: scenario-level + per-turn.
  failures.push(...evaluate(turnsEvents.flat(), scenario.expect, cfg).failures);
  turns.forEach((turn, i) => {
    if (!turn.expect) return;
    for (const f of evaluate(turnsEvents[i] || [], turn.expect, cfg).failures) {
      failures.push(`turn ${i + 1} (${JSON.stringify(turn.text)}): ${f}`);
    }
  });
  // CRM async expectations.
  if (crm) failures.push(...crm.failures.map((f) => `crm-db: ${f}`));

  const ok = failures.length === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  [${scenario.group}] ${scenario.name}`);
  turns.forEach((turn, i) => {
    const tr = evaluate(turnsEvents[i] || [], null, cfg);
    const g = tr.guardrail
      ? tr.guardrail.guardrailDecision
        ? `BLOCK:${tr.guardrail.guardrailDecision}`
        : `allow(${tr.guardrail.guardrailReason ?? ''})`
      : 'allow';
    const tools = tr.mcpReq.map((q) => q.toolName).join(',') || '-';
    const denies = tr.mcpPrivacyDenies.length ? ` deny:${tr.mcpPrivacyDenies.length}` : '';
    const reply = tr.outbound.find((o) => !RESET_REPLY_RE.test(o.reply || ''))?.reply ?? tr.llmOut?.reply ?? '';
    console.log(`  [${i + 1}] ${JSON.stringify(turn.text)}`);
    console.log(`      guardrail=${g} mcp=${tools}${denies} lang=${tr.replyLang}`);
    if (reply) console.log(`      reply: ${truncate(reply, 200)}`);
  });
  if (crm) {
    const summary = crm.records.length
      ? crm.records.map((r2) => `${r2.status}/${r2.intent_category}${r2.score != null ? `(${r2.score}${r2.band ? '·' + r2.band : ''})` : ''}`).join(', ')
      : '(none)';
    console.log(`      crm rows: ${summary}`);
  }
  if (!ok) for (const f of failures) console.log(`  -> ${f}`);
  return ok;
}

// Bounded-concurrency map (the host stalls past ~3 warm sessions at once).
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function main() {
  if (!fs.existsSync(LOG)) {
    console.error(`Dev log not found at ${LOG}. Start Gantry with GANTRY_FLOW_LOG=1 and tee to this path.`);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const groups = GROUP_FILTER.length ? GROUP_FILTER : ALL_GROUPS;
  const all = cfg.scenarios.filter((s) => groups.includes(s.group));
  const allowedPhones = new Set(ALL_TEST_PHONES);
  const phoneFailures = all.flatMap((s) => {
    if (s.group === 'crm' && !s.phone) return [`${s.name}: crm scenarios must declare a phone`];
    if (s.phone && !allowedPhones.has(s.phone)) return [`${s.name}: phone ${s.phone} is not in OPERATOR_LIST`];
    return [];
  });
  if (phoneFailures.length) {
    console.error('Scenario phone validation failed:');
    for (const f of phoneFailures) console.error(`  - ${f}`);
    process.exit(2);
  }
  const resultsByName = new Map();
  const t0 = Date.now();

  // Deterministic start: wipe the test phones' data + (re)seed the returning
  // persona, so greeting scenarios are true first-contact and crm scenarios start
  // with no stale rows. Skipped (with a warning) if the DB is unreachable.
  if (process.env.BOONDI_NO_RESET !== '1') {
    const resetPhones = [...new Set([...LANE_PHONES, ...all.filter((s) => s.phone).map((s) => s.phone)])];
    const needsSeed = all.some((s) => s.phone === RETURNING_PHONE);
    try {
      const c = await openClient();
      try {
        await resetTestData(c, resetPhones);
        if (needsSeed) await seedReturning(c, RETURNING_PHONE);
      } finally {
        await closeClient(c);
      }
      console.error(`reset ${resetPhones.length} test phones${needsSeed ? ' + seeded returning' : ''}`);
    } catch (err) {
      console.error(`⚠️  reset skipped (DB unavailable): ${err.message}`);
    }
  }

  console.error(`Running ${all.length} scenarios across groups: ${groups.join(', ')}`);

  // crm group FIRST, while the background extractor's queue is empty. Capture is
  // async: each session-end (/new) enqueues a digest the connector extracts one at a
  // time (~20s each). The conversation+shopify groups create ~80 such digests; if
  // those were produced first, the crm scenarios' digests would queue behind them and
  // only be extracted long after each per-scenario DB poll gives up. Running crm
  // first — empty queue, and the 120s+ polls throttling digest production to the
  // extractor's rate — lets each scenario's row land inside its poll window.
  const crm = all.filter((s) => s.group === 'crm');
  if (crm.length) {
    await mapPool(crm, CRM_CONCURRENCY, async (scenario) => {
      const r = await runScenario(scenario, scenario.phone);
      resultsByName.set(scenario.name, r);
      console.error(`  crm done: ${scenario.name}`);
    });
  }

  // Live-flow groups (conversation + shopify): round-robin across the lanes. Judged
  // synchronously from the flow-log, so the digest backlog they create (drained after
  // the run, nobody waiting on it) does not affect their result.
  const liveFlow = all.filter((s) => s.group !== 'crm');
  if (liveFlow.length) {
    const queues = LANE_PHONES.map(() => []);
    liveFlow.forEach((s, i) => queues[i % LANE_PHONES.length].push(s));
    await Promise.all(
      LANE_PHONES.map(async (lanePhone, laneIdx) => {
        for (const scenario of queues[laneIdx]) {
          resultsByName.set(scenario.name, await runScenario(scenario, lanePhone));
          console.error(`  lane${laneIdx} (${lanePhone}) done: ${scenario.name}`);
        }
      }),
    );
  }

  // Report grouped, in declared order.
  const perGroup = Object.fromEntries(groups.map((g) => [g, { pass: 0, fail: 0 }]));
  for (const g of groups) {
    console.log(`\n========== ${g.toUpperCase()} ==========`);
    for (const scenario of all.filter((s) => s.group === g)) {
      const r = resultsByName.get(scenario.name);
      if (!r) continue;
      if (reportScenario(r)) perGroup[g].pass += 1;
      else perGroup[g].fail += 1;
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n========== SUMMARY (${secs}s) ==========`);
  let anyFail = false;
  for (const g of groups) {
    const { pass, fail } = perGroup[g];
    if (fail) anyFail = true;
    console.log(`  ${fail === 0 ? 'PASS' : 'FAIL'}  ${g.padEnd(13)} ${pass} passed, ${fail} failed`);
  }
  process.exit(anyFail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
