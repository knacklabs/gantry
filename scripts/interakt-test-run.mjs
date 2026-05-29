#!/usr/bin/env node
// Drive the Boondi flow through the signed webhook and report what crossed each
// boundary, by reading the GANTRY_FLOW_LOG lines the runtime emits.
//
// Prereqs (see the plan / runbook): both dev servers running in watch mode with
//   GANTRY_FLOW_LOG=1  GANTRY_OUTBOUND_DRYRUN=1  GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633
//   SHOPIFY_MCP_REQUIRE_VERIFIED_IDENTITY=true
// and the Gantry stdout/stderr tee'd to GANTRY_DEV_LOG (default /tmp/gantry-dev.log).
//
// Usage: node scripts/interakt-test-run.mjs [scenarios.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendWebhook } from './interakt-test-send.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = process.env.GANTRY_DEV_LOG || '/tmp/gantry-dev.log';
const SCENARIOS_PATH = process.argv[2] || path.join(HERE, 'interakt-test-scenarios.json');
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 120_000);
const RESET_WAIT_MS = Number(process.env.RESET_WAIT_MS || 3_000);
// After the first terminal event of a turn, wait briefly for co-emitted events
// to land before snapshotting. The runtime sends the guardrail's canned reply
// (flow:outbound) and only then logs the flow:guardrail decision, and an agent
// turn's flow:llm.output trails its outbound — without this settle the harness
// returns on the first event and drops the rest of the turn's trace.
const SETTLE_MS = Number(process.env.SETTLE_MS || 700);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logSize = () => {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return 0;
  }
};

// Read the logfile slice appended since `fromOffset` (we mark the offset before
// each send so we only parse this turn's lines).
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

// Flow events appear in two log shapes: flowLog() lines whose MESSAGE is
// `flow:<event>` (outbound, mcp.*, llm.*), and guardrail decisions logged as a
// human message ("Guardrail handled…") that carry the tag only inside the JSON
// context as `"flow":"guardrail"`. Match the JSON field so BOTH are captured —
// keying off the `flow:` message substring alone silently drops guardrail events.
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
    if (!obj || typeof obj.flow !== 'string') continue;
    const eventJid = obj.jid ?? obj.chatJid;
    if (chatJid && eventJid && eventJid !== chatJid) continue;
    events.push(obj);
  }
  return events;
}

async function waitForTurn(fromOffset, chatJid) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  // Snapshot after a short settle so trailing co-emitted events (the guardrail
  // decision after its reply; llm.output after the agent's outbound) are kept.
  const settleAndSnapshot = async () => {
    await sleep(SETTLE_MS);
    return parseFlowEvents(readSlice(fromOffset), chatJid);
  };
  while (Date.now() < deadline) {
    const events = parseFlowEvents(readSlice(fromOffset), chatJid);
    // A turn is done once the reply is emitted (agent path: llm.output, or the
    // outbound send for either the agent reply or a guardrail canned reply), or
    // when the guardrail returns a direct response (no agent is spawned).
    if (events.some((e) => e.flow === 'outbound' || e.flow === 'llm.output')) {
      return settleAndSnapshot();
    }
    if (events.some((e) => e.flow === 'guardrail' && e.guardrailDecision)) {
      return settleAndSnapshot();
    }
    await sleep(1_000);
  }
  return parseFlowEvents(readSlice(fromOffset), chatJid);
}

// Privacy denials surface two ways: the Shopify MCP returns them as a tool
// RESULT with isError:true (flow:mcp.response), and a transport/proxy rejection
// throws (flow:mcp.error). Match the privacy codes/text in either shape.
const PRIVACY_DENY_RE =
  /ARG_VS_HEADER_MISMATCH|PRIVACY_GUARD|CUSTOMER_ID_MISMATCH|IDENTITY_MISMATCH|only check details linked to|phone number you are messaging from|does(?:n't| not) match that number|your own (?:account|number|phone)/i;

function responseText(ev) {
  // flow:mcp.response carries the raw MCP result { content:[{text}], isError }.
  const parts = ev?.result?.content;
  if (Array.isArray(parts)) {
    return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ');
  }
  return JSON.stringify(ev?.result ?? {});
}
const isPrivacyDenyResponse = (ev) =>
  ev?.result?.isError === true && PRIVACY_DENY_RE.test(responseText(ev));
const replyRefusesAccess = (text) =>
  typeof text === 'string' &&
  /only (?:share|check|look up|pull up|access|help).*(?:own|your)|can'?t (?:share|look up|access|pull up|do) that|not able to (?:share|look up|access|pull up)|does(?:n't| not) match|linked to (?:your|the).*number/i.test(
    text,
  );

function evaluate(events, scenario, cfg) {
  const by = (f) => events.filter((e) => e.flow === f);
  const guardrail = events.find((e) => e.flow === 'guardrail');
  const mcpReq = by('mcp.request');
  const mcpErr = by('mcp.error');
  const mcpResp = by('mcp.response');
  const outbound = by('outbound');
  const llmOut = events.find((e) => e.flow === 'llm.output');
  const exp = scenario.expect || {};
  const failures = [];
  // Privacy denials seen at the MCP layer this turn (thrown OR isError result).
  const mcpPrivacyDenies = [
    ...mcpErr.filter((e) => PRIVACY_DENY_RE.test(e.error || '')),
    ...mcpResp.filter(isPrivacyDenyResponse),
  ];

  if (exp.guardrail && guardrail?.guardrailDecision !== exp.guardrail) {
    failures.push(
      `expected guardrail "${exp.guardrail}", got "${guardrail?.guardrailDecision ?? 'none'}"`,
    );
  }
  if (exp.mcp && mcpReq.length === 0) failures.push('expected an MCP call, none seen');
  if (exp.allow && mcpErr.length > 0) {
    // Fail only on a thrown/transport MCP error. A privacy-guard isError result
    // is NOT a failure here: in test mode the agent may pass the messaging
    // number (which mismatches the overridden identity), get denied, then retry
    // with empty args and succeed. The reply is eyeballed for correctness; the
    // hard ALLOW invariant is just "no transport error reaching the agent".
    failures.push(`expected ALLOW but MCP errored: ${mcpErr.map((e) => e.error).join('; ')}`);
  }
  if (exp.deny) {
    // Defense-in-depth: the MCP privacy guard should reject the mismatched
    // lookup. A bare agent refusal (no MCP deny) still protects the customer, so
    // accept it too, but only when nothing leaked at the MCP layer.
    const replyRefused = [llmOut?.reply, ...outbound.map((o) => o.reply)].some(
      replyRefusesAccess,
    );
    if (mcpPrivacyDenies.length === 0 && !replyRefused) {
      failures.push('expected a privacy DENY, none seen (no MCP privacy guard, no refusal in reply)');
    }
  }
  // SAFETY invariant: every outbound delivery targets the REAL number. The reply
  // must never be routed to the test number, regardless of identity override.
  for (const o of outbound) {
    if (o.jid !== `wa:${cfg.realFrom}`) {
      failures.push(`SAFETY: outbound jid "${o.jid}" is not wa:${cfg.realFrom}`);
    }
  }
  return { guardrail, mcpReq, mcpErr, mcpResp, mcpPrivacyDenies, outbound, llmOut, failures };
}

function printReport(scenario, turnsEvents, cfg) {
  const all = turnsEvents.flat();
  const r = evaluate(all, scenario, cfg);
  const ok = r.failures.length === 0;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${scenario.name}`);
  console.log(`  turns: ${scenario.turns.map((t) => JSON.stringify(t)).join(' , ')}`);
  if (r.guardrail) {
    console.log(`  guardrail: ${r.guardrail.guardrailDecision ?? 'allow'} (${r.guardrail.guardrailReason ?? ''})`);
  }
  for (const q of r.mcpReq) {
    console.log(`  mcp.request: ${q.toolName} identity=${q.callerIdentityJid ?? '?'} args=${JSON.stringify(q.arguments)}`);
  }
  for (const e of r.mcpErr) console.log(`  mcp.error: ${e.error}`);
  for (const e of r.mcpPrivacyDenies) {
    if (e.flow === 'mcp.response') {
      console.log(`  mcp.deny: ${e.toolName} -> ${truncate(responseText(e), 160)}`);
    }
  }
  if (r.llmOut) console.log(`  reply: ${truncate(r.llmOut.reply, 280)}`);
  else if (r.outbound[0]) console.log(`  reply(outbound): ${truncate(r.outbound[0].reply, 280)}`);
  if (!ok) for (const f of r.failures) console.log(`  -> ${f}`);
  return ok;
}

const truncate = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

async function main() {
  if (!fs.existsSync(LOG)) {
    console.error(`Dev log not found at ${LOG}. Start Gantry with GANTRY_FLOW_LOG=1 and tee to this path.`);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  const realFrom = cfg.realFrom || '919654405340';
  let passed = 0;
  let failed = 0;

  for (const scenario of cfg.scenarios) {
    if (scenario.reset !== false) {
      await sendWebhook({ text: '/new', from: realFrom });
      await sleep(RESET_WAIT_MS);
    }
    const chatJid = `wa:${realFrom}`;
    const turnsEvents = [];
    for (const text of scenario.turns) {
      const offset = logSize();
      const sent = await sendWebhook({ text, from: realFrom });
      if (!sent.ok) {
        console.log(`\nFAIL  ${scenario.name}\n  -> webhook rejected (HTTP ${sent.status}): ${sent.response}`);
        turnsEvents.length = 0;
        break;
      }
      turnsEvents.push(await waitForTurn(offset, chatJid));
    }
    if (printReport(scenario, turnsEvents, { ...cfg, realFrom })) passed += 1;
    else failed += 1;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
