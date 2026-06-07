#!/usr/bin/env node
// Performance probe: measures per-turn customer-visible latency against the
// locally running Gantry dev runtime. This is the single latency probe for the
// Boondi script harness.
//
// What it does: posts a signed Interakt webhook for each representative turn
// (via lib/webhook.mjs), then slices the runtime flow log (GANTRY_DEV_LOG,
// default /tmp/gantry-dev.log) from the byte offset taken just before the send.
// From that slice it reports the wall-clock time from send to the first
// customer-visible 'outbound' reply, plus the MCP round-trip time when the turn
// hit a tool. Turns: a greeting (guardrail fast path), a cold order lookup
// (full agent+MCP path), and an immediate warm follow-up (reused SDK session).
// Flow events are log lines containing `"flow":` over a JSON object; relevant
// flows: outbound (.reply/.jid), mcp.request, mcp.response, llm.input/output.
//
// Usage: node scripts/measure-latency.mjs   (requires the dev server running)
import fs from 'node:fs';
import { sendWebhook } from './lib/webhook.mjs';

const LOG = process.env.GANTRY_DEV_LOG || '/tmp/gantry-dev.log';
const FROM = '919900050001'; // fake sender — never a real number (would receive sends)
const RESET_REPLY = 'Started a fresh session';
const TIMEOUT_MS = 90_000; // generous: cold turns boot the runner + run the agent
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const size = () => {
  try {
    return fs.statSync(LOG).size;
  } catch {
    return 0;
  }
};

// Read the log bytes appended since `from`.
function slice(from) {
  const s = size();
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

// Extract flow events from a log slice. Timestamp comes from the leading
// [ISO] bracket, falling back to a time/timestamp field inside the JSON.
function events(text) {
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
    if (json && typeof json.flow !== 'string' && json.context && typeof json.context.flow === 'string') {
      json = json.context;
    }
    if (typeof json.flow !== 'string') continue;
    const iso = line.match(/^\[([0-9T:.Z+-]+)\]/);
    const t = Date.parse(iso ? iso[1] : json.time || json.timestamp);
    if (Number.isNaN(t)) continue;
    out.push({ t, flow: json.flow, reply: json.reply, toolName: json.toolName });
  }
  return out;
}

// Drive one turn: snapshot the offset, send, then poll the slice until the
// first non-reset outbound reply appears (or we time out).
async function turn(text) {
  const off = size();
  const sentAt = Date.now();
  const sent = await sendWebhook({ text, from: FROM });
  if (!sent.ok) throw new Error(`webhook rejected (HTTP ${sent.status}): ${sent.response}`);
  let ev = [];
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    ev = events(slice(off));
    if (ev.some((e) => e.flow === 'outbound' && !String(e.reply || '').includes(RESET_REPLY))) break;
    await sleep(500);
  }
  await sleep(300); // let any trailing mcp.response/outbound lines flush
  ev = events(slice(off));

  const reply = ev.find((e) => e.flow === 'outbound' && !String(e.reply || '').includes(RESET_REPLY));
  const req = ev.find((e) => e.flow === 'mcp.request');
  const resp = [...ev].reverse().find((e) => e.flow === 'mcp.response');
  return {
    msToReply: reply ? reply.t - sentAt : null,
    mcpMs: req && resp && resp.t >= req.t ? resp.t - req.t : null,
    tools: ev.filter((e) => e.flow === 'mcp.request').length,
  };
}

async function main() {
  // Reset to a cold session so the greeting + cold-order turns start clean.
  await sendWebhook({ text: '/new', from: FROM });
  await sleep(2000);

  const plan = [
    { turn: 'greeting', path: 'guardrail fast-path', text: 'hi' },
    { turn: 'cold order', path: 'agent + MCP', text: 'What was my last order?' },
    { turn: 'warm follow-up', path: 'warm session', text: 'and was it delivered?' },
  ];

  const rows = [];
  for (const step of plan) {
    const r = await turn(step.text);
    rows.push({ ...step, ...r });
  }

  const fmtMs = (x) => (x == null ? '—' : `${x}ms`);
  const fmtMcp = (r) => (r.mcpMs == null ? (r.tools ? `${r.tools} call(s)` : '—') : `${r.mcpMs}ms`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nLatency probe (log: ${LOG}, from: ${FROM})\n`);
  console.log(pad('turn', 16), pad('path', 22), pad('ms-to-reply', 12), 'mcp-ms');
  console.log('-'.repeat(62));
  for (const r of rows) {
    console.log(pad(r.turn, 16), pad(r.path, 22), pad(fmtMs(r.msToReply), 12), fmtMcp(r));
  }
  console.log('');
  process.exit(rows.some((r) => r.msToReply == null) ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
