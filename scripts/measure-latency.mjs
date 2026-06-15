#!/usr/bin/env node
// Boondi latency suite — per-stage, multi-sample reply-latency measurement.
//
// Implements the verification protocol of
// docs/BOONDI-LATENCY-DIAGNOSIS-2026-06-10.md §3a against the locally running
// dev runtime (docs/BOONDI-E2E-TESTING.md method: signed webhooks from fake
// listed numbers, flow-log timestamps, admin panel as proof of record):
//
//   1. Account-pressure context: every sample is stamped with the latest
//      `flow:model.rate_limit` utilization seen for its conversation (emitted
//      by the runner per session; warm turns carry the last seen value).
//   2. Timestamps come from the flow log and the Claude-CLI session
//      transcripts, never poll-arrival times.
//   3. Cold and warm are measured separately: cold turns get a `/new` session
//      reset first (T1 additionally gets a DB reset so the cold-contact
//      guardrail greeting fires); the warm turn (T4) follows T3 in the same
//      sample with no reset. Samples default to 3; medians are reported.
//   4. Slot isolation: every send waits until no agent-runner child process is
//      alive, so queue waits never contaminate a sample. Run core with a short
//      IDLE_TIMEOUT (e.g. 2500) per docs/BOONDI-E2E-TESTING.md §3. This also
//      makes the warm turn deterministic (session-resume warm, not a race
//      against the live child's idle window).
//
// Per-sample detail: per-stage table from the flow log (pickup+guardrail,
// spawn, MCP round-trips, post-result tail) plus per-round LLM timings and
// cache_read/creation token counts from the session transcript JSONL.
//
// Usage:
//   node scripts/measure-latency.mjs [--samples N] [--only T1,T5] [--json out.json]
// Env: GANTRY_DEV_LOG (core stdout log file — must match the running core),
//      GANTRY_TRANSCRIPT_DIR, LATENCY_TURN_TIMEOUT_MS, LATENCY_SLOT_WAIT_MS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sendWebhook } from './lib/webhook.mjs';
import { openClient, closeClient } from './lib/crm-db.mjs';
import { resetTestData } from './lib/reset.mjs';

const LOG = process.env.GANTRY_DEV_LOG || '/tmp/gantry-dev.log';
const TRANSCRIPT_DIR =
  process.env.GANTRY_TRANSCRIPT_DIR ||
  path.join(
    os.homedir(),
    'gantry/agents/boondi_support/.llm-runtime/claude/projects/-Users-caw-d-gantry-agents-boondi-support',
  );
const RUNNER_PROC_PATTERN =
  process.env.GANTRY_RUNNER_PROC_PATTERN || 'anthropic-claude-agent/runner';
const TURN_TIMEOUT_MS = Number(process.env.LATENCY_TURN_TIMEOUT_MS || 90_000);
const SLOT_WAIT_MS = Number(process.env.LATENCY_SLOT_WAIT_MS || 120_000);
const RESET_TIMEOUT_MS = 25_000;
const RESET_REPLY = 'Started a fresh session';
const SETTLE_MS = 700;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixed scenario set mirroring the diagnosis report (§3a). Phones are fake
// listed numbers (shared with the regression pool, which resets them pre-run).
const SCENARIOS = [
  {
    id: 'T1',
    name: 'greeting (guardrail floor)',
    phone: '000000041',
    text: 'hi',
    kind: 'guardrail',
    reset: 'db', // cold-contact greeting fires only for a phone with no history
  },
  {
    id: 'T2',
    name: 'policy question',
    phone: '000000042',
    text: 'Do you do home delivery in Mumbai?',
    kind: 'cold',
    reset: 'session',
  },
  {
    id: 'T3',
    name: 'product lookup',
    phone: '000000043',
    text: 'Do you have kaju katli? What does it cost?',
    kind: 'cold',
    reset: 'session',
  },
  {
    id: 'T4',
    name: 'warm follow-up (resume)',
    phone: '000000043', // rides T3's session, no reset
    text: 'and how much would half a kilo cost?',
    kind: 'warm',
  },
  {
    id: 'T5',
    name: 'order status',
    phone: '000000044',
    text: 'Check my last order?',
    kind: 'cold',
    reset: 'session',
  },
];

function parseArgs(argv) {
  const args = { samples: 3, json: null, only: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--samples') args.samples = Number(argv[++i]);
    else if (a === '--json') args.json = argv[++i];
    else if (a === '--only')
      args.only = argv[++i].split(',').map((s) => s.trim());
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.samples) || args.samples < 1) {
    throw new Error('--samples must be a positive integer');
  }
  return args;
}

// ---------- flow log ----------

function logSize() {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return 0;
  }
}

function logSlice(from) {
  const s = logSize();
  if (s <= from) return '';
  const fd = fs.openSync(LOG, 'r');
  try {
    const b = Buffer.alloc(s - from);
    fs.readSync(fd, b, 0, b.length, from);
    return b.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Extract flow events from a log slice, keeping the fields the suite needs.
// Timestamp: leading [ISO] bracket, else time/timestamp inside the JSON.
function flowEvents(text, phone) {
  const out = [];
  for (const line of text.split('\n')) {
    const brace = line.indexOf('{');
    if (brace === -1 || !line.includes('"flow":')) continue;
    let json;
    try {
      json = JSON.parse(line.slice(brace));
    } catch {
      continue;
    }
    const envelope = json;
    if (
      json &&
      typeof json.flow !== 'string' &&
      json.context &&
      typeof json.context.flow === 'string'
    ) {
      json = json.context;
    }
    if (typeof json.flow !== 'string') continue;
    const iso = line.match(/^\[([0-9T:.Z+-]+)\]/);
    const t = Date.parse(
      iso
        ? iso[1]
        : json.time || json.timestamp || envelope.time || envelope.timestamp,
    );
    if (Number.isNaN(t)) continue;
    const jid = json.jid || json.chatJid || null;
    if (phone && jid && !String(jid).includes(phone)) continue;
    out.push({
      t,
      flow: json.flow,
      jid,
      reply: json.reply,
      toolName: json.toolName,
      serverName: json.serverName,
      guardrailDecision: json.guardrailDecision,
      resumed: json.resumed,
      utilization: json.utilization,
      rateLimitStatus: json.status,
      rateLimitType: json.rateLimitType,
      model: json.model,
      output: json.output,
      cacheRead: json.cacheRead,
      cacheWrite: json.cacheWrite,
      costUsd: json.costUsd,
    });
  }
  return out;
}

const isReply = (e) =>
  e.flow === 'outbound' && !String(e.reply || '').includes(RESET_REPLY);

async function waitForEvent(off, phone, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ev = flowEvents(logSlice(off), phone);
    if (ev.some(predicate)) return ev;
    if (Date.now() > deadline) return null;
    await sleep(1000);
  }
}

// ---------- slot isolation ----------

function activeRunnerPids() {
  try {
    const pids = execFileSync('pgrep', ['-f', RUNNER_PROC_PATTERN], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    return pids.filter((pid) => !isWarmPoolWorkerPid(pid));
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

function isWarmPoolWorkerPid(pid) {
  try {
    const command = execFileSync('ps', ['-p', pid, '-o', 'command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return command.includes('--gantry-warm-pool-worker=');
  } catch {
    return false;
  }
}

async function waitForSlotIsolation() {
  const deadline = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    const pids = activeRunnerPids();
    if (pids.length === 0) return true;
    if (Date.now() > deadline) {
      console.error(
        `  ! slot isolation timeout: runner pids still alive: ${pids.join(', ')}`,
      );
      return false;
    }
    await sleep(1000);
  }
}

// ---------- session transcripts (per-round LLM evidence) ----------

function transcriptSnapshot() {
  const sizes = new Map();
  let names = [];
  try {
    names = fs.readdirSync(TRANSCRIPT_DIR).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return sizes; // missing dir → no per-round evidence, reported as such
  }
  for (const name of names) {
    try {
      sizes.set(name, fs.statSync(path.join(TRANSCRIPT_DIR, name)).size);
    } catch {
      /* file rotated away mid-scan */
    }
  }
  return sizes;
}

// Parse the appended region of every transcript that grew since the snapshot.
// Returns chronological entries; assistant entries carry usage + tool names.
function transcriptEntriesSince(snapshot, sinceMs) {
  const entries = [];
  let names = [];
  try {
    names = fs.readdirSync(TRANSCRIPT_DIR).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return entries;
  }
  for (const name of names) {
    const file = path.join(TRANSCRIPT_DIR, name);
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    const from = snapshot.get(name) ?? 0;
    if (size <= from) continue;
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const b = Buffer.alloc(size - from);
      fs.readSync(fd, b, 0, b.length, from);
      text = b.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const tMs = Date.parse(obj.timestamp || '');
      if (Number.isNaN(tMs) || tMs < sinceMs) continue;
      if (obj.type === 'assistant' && obj.message?.usage) {
        const usage = obj.message.usage;
        const content = Array.isArray(obj.message.content)
          ? obj.message.content
          : [];
        entries.push({
          tMs,
          kind: 'assistant',
          session: obj.sessionId,
          model: obj.message.model,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          tools: content
            .filter((c) => c?.type === 'tool_use')
            .map((c) => c.name),
          stop: obj.message.stop_reason,
        });
      } else {
        entries.push({
          tMs,
          kind: obj.type || 'other',
          session: obj.sessionId,
        });
      }
    }
  }
  entries.sort((a, b) => a.tMs - b.tMs);
  return entries;
}

// Collapse transcript entries into per-API-round rows: each assistant entry's
// duration is measured from the immediately preceding entry (the diagnosis
// methodology — per-API-call timestamps).
function roundsFromEntries(entries) {
  const rounds = [];
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.kind !== 'assistant') continue;
    const prev = entries[i - 1];
    rounds.push({
      ms: prev ? e.tMs - prev.tMs : null,
      at: e.tMs,
      model: e.model,
      cacheRead: e.cacheRead,
      cacheWrite: e.cacheWrite,
      outputTokens: e.outputTokens,
      tools: e.tools,
      stop: e.stop,
    });
  }
  return rounds;
}

// ---------- per-turn measurement ----------

function mcpSpans(events) {
  const spans = [];
  const open = [];
  for (const e of events) {
    if (e.flow === 'mcp.request') open.push(e);
    else if (e.flow === 'mcp.response' || e.flow === 'mcp.error') {
      const req = open.shift();
      if (req) {
        spans.push({
          tool: req.toolName,
          server: req.serverName,
          ms: e.t - req.t,
          error: e.flow === 'mcp.error' || undefined,
        });
      }
    }
  }
  return spans;
}

async function measureTurn(scenario, ctx) {
  const phone = scenario.phone;
  const snapshot = transcriptSnapshot();
  const off = logSize();
  const sentAt = Date.now();
  const sent = await sendWebhook({
    text: scenario.text,
    from: phone,
    name: 'Latency Suite',
  });
  if (!sent.ok)
    throw new Error(`webhook rejected (HTTP ${sent.status}): ${sent.response}`);

  const found = await waitForEvent(off, phone, isReply, TURN_TIMEOUT_MS);
  await sleep(SETTLE_MS); // let trailing mcp.response / model.usage lines flush
  const events = flowEvents(logSlice(off), phone);

  const reply = events.find(isReply);
  const guardrail = events.find((e) => e.flow === 'guardrail');
  const llmInput = events.find((e) => e.flow === 'llm.input');
  const spans = mcpSpans(events);
  const usageEvents = events.filter((e) => e.flow === 'model.usage');
  const rate = [...events].reverse().find((e) => e.flow === 'model.rate_limit');
  if (rate)
    ctx.lastRateLimit = {
      utilization: rate.utilization,
      status: rate.rateLimitStatus,
      type: rate.rateLimitType,
      at: rate.t,
      carried: false,
    };

  const entries = transcriptEntriesSince(snapshot, sentAt - 2_000);
  const rounds = roundsFromEntries(entries);
  const lastAssistantAt = rounds.length ? rounds[rounds.length - 1].at : null;

  const totalMs = reply ? reply.t - sentAt : null;
  return {
    scenario: scenario.id,
    ok: Boolean(reply),
    timedOut: !found,
    sentAt,
    totalMs,
    stages: {
      pickupGuardrailMs: guardrail ? guardrail.t - sentAt : null,
      spawnToLlmInputMs:
        guardrail && llmInput ? llmInput.t - guardrail.t : null,
      mcpTotalMs: spans.length ? spans.reduce((acc, s) => acc + s.ms, 0) : null,
      // Post-result tail: reply persisted/sent minus the final LLM round's
      // completion (transcript timestamp). The getContextUsage() tail (RC4)
      // lives here; F2 should collapse it to ~0.1s.
      postResultTailMs:
        reply && lastAssistantAt ? reply.t - lastAssistantAt : null,
    },
    mcp: spans,
    rounds: rounds.map(({ at, ...r }) => r),
    roundCount: rounds.length,
    firstRound: rounds.length
      ? { cacheRead: rounds[0].cacheRead, cacheWrite: rounds[0].cacheWrite }
      : null,
    resumed: llmInput ? Boolean(llmInput.resumed) : null,
    guardrailDecision: guardrail?.guardrailDecision ?? null,
    usageEventCount: usageEvents.length,
    rateLimit: ctx.lastRateLimit
      ? { ...ctx.lastRateLimit, carried: !rate }
      : null,
    replyPreview: reply ? String(reply.reply || '').slice(0, 80) : null,
  };
}

async function sessionReset(phone) {
  const off = logSize();
  const sent = await sendWebhook({
    text: '/new',
    from: phone,
    name: 'Latency Suite',
  });
  if (!sent.ok) throw new Error(`/new webhook rejected (HTTP ${sent.status})`);
  const ok = await waitForEvent(
    off,
    phone,
    (e) => e.flow === 'outbound' && String(e.reply || '').includes(RESET_REPLY),
    RESET_TIMEOUT_MS,
  );
  if (!ok)
    throw new Error(
      `session reset for ${phone} got no confirmation within ${RESET_TIMEOUT_MS}ms`,
    );
}

// ---------- aggregation ----------

function median(values) {
  const v = values
    .filter((x) => typeof x === 'number' && Number.isFinite(x))
    .sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

function summarize(scenario, samples) {
  const ok = samples.filter((s) => s.ok);
  return {
    id: scenario.id,
    name: scenario.name,
    kind: scenario.kind,
    phone: scenario.phone,
    samples: samples.length,
    succeeded: ok.length,
    totalsMs: samples.map((s) => s.totalMs),
    medianTotalMs: median(ok.map((s) => s.totalMs)),
    medianStages: {
      pickupGuardrailMs: median(ok.map((s) => s.stages.pickupGuardrailMs)),
      spawnToLlmInputMs: median(ok.map((s) => s.stages.spawnToLlmInputMs)),
      mcpTotalMs: median(ok.map((s) => s.stages.mcpTotalMs)),
      postResultTailMs: median(ok.map((s) => s.stages.postResultTailMs)),
    },
    medianRoundCount: median(ok.map((s) => s.roundCount)),
    medianFirstCacheRead: median(
      ok.map((s) => s.firstRound?.cacheRead ?? null),
    ),
    medianFirstCacheWrite: median(
      ok.map((s) => s.firstRound?.cacheWrite ?? null),
    ),
    utilizations: samples.map(
      (s) => s.rateLimit?.utilization ?? s.rateLimit?.status ?? null,
    ),
  };
}

const fmt = (x, suffix = '') => (x == null ? '—' : `${x}${suffix}`);

function printSummary(rows) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    `\n${pad('scenario', 28)} ${pad('n', 4)} ${pad('median', 9)} ${pad('guard', 7)} ${pad('mcp', 7)} ${pad('tail', 7)} ${pad('rounds', 7)} ${pad('cW(first)', 10)} ${pad('cR(first)', 10)} util`,
  );
  console.log('-'.repeat(110));
  for (const r of rows) {
    console.log(
      `${pad(`${r.id} ${r.name}`, 28)} ${pad(`${r.succeeded}/${r.samples}`, 4)} ${pad(fmt(r.medianTotalMs, 'ms'), 9)} ${pad(fmt(r.medianStages.pickupGuardrailMs), 7)} ${pad(fmt(r.medianStages.mcpTotalMs), 7)} ${pad(fmt(r.medianStages.postResultTailMs), 7)} ${pad(fmt(r.medianRoundCount), 7)} ${pad(fmt(r.medianFirstCacheWrite), 10)} ${pad(fmt(r.medianFirstCacheRead), 10)} ${r.utilizations.map((u) => (u == null ? '—' : u)).join(',')}`,
    );
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv);
  const scenarios = args.only
    ? SCENARIOS.filter((s) => args.only.includes(s.id))
    : SCENARIOS;
  if (!scenarios.length) throw new Error('no scenarios selected');
  if (
    args.only &&
    scenarios.some((s) => s.id === 'T4') &&
    !scenarios.some((s) => s.id === 'T3')
  ) {
    throw new Error(
      "T4 (warm) requires T3 in the same run — it rides T3's session",
    );
  }
  if (!fs.existsSync(LOG)) {
    throw new Error(
      `flow log ${LOG} does not exist — start core with stdout to that file and GANTRY_FLOW_LOG=1 (docs/BOONDI-E2E-TESTING.md §3/§8)`,
    );
  }
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    console.error(
      `! transcript dir missing (${TRANSCRIPT_DIR}) — per-round evidence will be empty`,
    );
  }

  console.log(
    `Latency suite: ${scenarios.map((s) => s.id).join(', ')} × ${args.samples} sample(s)`,
  );
  console.log(`flow log: ${LOG}`);

  const ctx = { lastRateLimit: null };
  let db = null;
  const needsDbReset = scenarios.some((s) => s.reset === 'db');
  if (needsDbReset) db = await openClient();

  const bySid = new Map(scenarios.map((s) => [s.id, []]));
  try {
    for (let sample = 1; sample <= args.samples; sample += 1) {
      console.log(`\n— sample ${sample}/${args.samples} —`);
      for (const scenario of scenarios) {
        const isolated = await waitForSlotIsolation();
        if (!isolated) {
          bySid
            .get(scenario.id)
            .push({
              scenario: scenario.id,
              ok: false,
              slotViolation: true,
              totalMs: null,
              stages: {},
              rounds: [],
              roundCount: 0,
            });
          console.log(`  ${scenario.id} SKIPPED (slot isolation not reached)`);
          continue;
        }
        if (scenario.reset === 'db') {
          await resetTestData(db, [scenario.phone]);
        } else if (scenario.reset === 'session') {
          await sessionReset(scenario.phone);
        }
        const result = await measureTurn(scenario, ctx);
        bySid.get(scenario.id).push(result);
        // The SDK includes `utilization` only above its warning threshold;
        // below it the status string is the pressure stamp.
        const util = result.rateLimit
          ? ` util=${result.rateLimit.utilization ?? result.rateLimit.status}${result.rateLimit.carried ? '*' : ''}`
          : '';
        console.log(
          `  ${scenario.id} ${result.ok ? `${result.totalMs}ms` : 'TIMEOUT'} rounds=${result.roundCount} tail=${fmt(result.stages.postResultTailMs)} mcp=${fmt(result.stages.mcpTotalMs)}${util}`,
        );
      }
    }
  } finally {
    if (db) await closeClient(db);
  }

  const rows = scenarios.map((s) => summarize(s, bySid.get(s.id)));
  printSummary(rows);

  const out = {
    startedAt: new Date().toISOString(),
    log: LOG,
    samples: args.samples,
    scenarios: rows,
    detail: Object.fromEntries([...bySid.entries()]),
  };
  const jsonPath = args.json || `/tmp/latency-suite-${Date.now()}.json`;
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));
  console.log(`detail JSON: ${jsonPath}`);
  console.log(
    'Admin-panel proof: http://localhost:3000/?c=conversation:wa:<phone> for phones ' +
      [...new Set(scenarios.map((s) => s.phone))].join(', '),
  );

  process.exit(rows.some((r) => r.succeeded === 0) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
