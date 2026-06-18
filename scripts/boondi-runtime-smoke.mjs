#!/usr/bin/env node
// Basic local runtime smoke for Boondi-on-Gantry.
//
// This intentionally does NOT judge Boondi product behavior, CRM extraction,
// reply wording, or Shopify catalogue semantics. It proves only:
//   1. core, shopify-api MCP, and boondi-crm MCP are reachable;
//   2. signed Interakt webhooks ACK;
//   3. inbound reaches guardrail/agent processing;
//   4. Gantry emits MCP proxy request/response events for an agent MCP turn;
//   5. outbound dry-run emits a customer-visible send event.
//   6. duplicate provider message ids do not trigger duplicate runtime work.
//   7. authenticated runtime worker inventory is reachable.
// Set SMOKE_CONCURRENCY=3 to exercise the local three-warm-worker runtime
// hypothesis, or SMOKE_CONCURRENCY=5 SMOKE_CASE_COUNT=5 for the provider-sizing
// gate. Extra cases use generated 000-prefixed fake phones.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { parseRuntimeSmokeEnv } from './lib/runtime-smoke-env.mjs';
import { sendWebhook } from './lib/webhook.mjs';

const smokeEnv = parseRuntimeSmokeEnv();
const LOG_PATHS = (smokeEnv.gantryDevLog || '/tmp/gantry-dev.log')
  .split(',')
  .map((path) => path.trim())
  .filter(Boolean);
const CORE_PORT = Number(smokeEnv.controlPort || 4710);
const RUNTIME_WORKERS_PATH = '/v1/runtime/workers';
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 180_000);
const POLL_MS = Number(process.env.SMOKE_POLL_MS || 1_000);
const DUPLICATE_SETTLE_MS = Number(
  process.env.SMOKE_DUPLICATE_SETTLE_MS || 5_000,
);
const SMOKE_CONCURRENCY = Math.max(
  1,
  Number(process.env.SMOKE_CONCURRENCY || 1),
);
const SMOKE_CASE_COUNT = Math.max(0, Number(process.env.SMOKE_CASE_COUNT || 0));
const GENERATED_PHONE_START = Number(
  process.env.SMOKE_GENERATED_PHONE_START || 100,
);

const allCases = [
  {
    name: 'shopify',
    phone: process.env.BOONDI_SMOKE_SHOPIFY_PHONE || '000000001',
    text: process.env.BOONDI_SMOKE_SHOPIFY_TEXT || 'Do you have kaju katli?',
    serverName: 'shopify-api',
  },
  {
    name: 'shopify-secondary',
    phone: process.env.BOONDI_SMOKE_SHOPIFY_SECONDARY_PHONE || '000000002',
    text:
      process.env.BOONDI_SMOKE_SHOPIFY_SECONDARY_TEXT ||
      'Can you show me sweets?',
    serverName: 'shopify-api',
  },
  {
    name: 'crm',
    phone: process.env.BOONDI_SMOKE_CRM_PHONE || '000000050',
    text: process.env.BOONDI_SMOKE_CRM_TEXT || 'hi',
    serverName: 'boondi-crm',
    expectAgentMcpFlow: false,
  },
];

const SMOKE_CASES = (process.env.SMOKE_CASES || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const cases =
  SMOKE_CASES.length > 0
    ? allCases.filter((smokeCase) => SMOKE_CASES.includes(smokeCase.name))
    : allCases;
if (cases.length === 0) {
  throw new Error(
    `SMOKE_CASES did not match any runtime smoke cases: ${SMOKE_CASES.join(', ')}`,
  );
}

function generatedPhone(index) {
  return String(GENERATED_PHONE_START + index).padStart(9, '0');
}

function expandCasesForSizing(selectedCases) {
  const targetCount = SMOKE_CASE_COUNT || selectedCases.length;
  if (targetCount <= selectedCases.length)
    return selectedCases.slice(0, targetCount);
  const expanded = [...selectedCases];
  for (let index = selectedCases.length; index < targetCount; index += 1) {
    const base = selectedCases[index % selectedCases.length];
    expanded.push({
      ...base,
      name: `${base.name}-extra-${index - selectedCases.length + 1}`,
      phone: generatedPhone(index),
    });
  }
  return expanded;
}

const smokeCases = expandCasesForSizing(cases);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mapPool(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

function logSize(path) {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function logOffsets() {
  return LOG_PATHS.map((path) => ({ path, offset: logSize(path) }));
}

function readLogSincePath(path, offset) {
  try {
    const fd = fs.openSync(path, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.min(offset, size);
      const buffer = Buffer.alloc(Math.max(0, size - start));
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readLogsSince(offsets) {
  return offsets
    .map(({ path, offset }) => readLogSincePath(path, offset))
    .join('\n');
}

function parseJsonLogLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function eventTimeMs(entry) {
  const raw =
    entry?.time ||
    entry?.timestamp ||
    entry?.context?.time ||
    entry?.context?.timestamp;
  const parsed = Date.parse(raw || '');
  return Number.isNaN(parsed) ? null : parsed;
}

function logContextMatchesChat(context, chatJid) {
  return context?.chatJid === chatJid || context?.jid === chatJid;
}

function flowEntriesForChat(text, chatJid, flow, serverName) {
  return parseJsonLogLines(text).filter((entry) => {
    const context = entry?.context;
    if (context?.flow !== flow) return false;
    if (!logContextMatchesChat(context, chatJid)) return false;
    return serverName ? context.serverName === serverName : true;
  });
}

function hasFlowForChat(text, chatJid, flow, serverName) {
  return flowEntriesForChat(text, chatJid, flow, serverName).length > 0;
}

function countFlowForChat(text, chatJid, flow, serverName) {
  return flowEntriesForChat(text, chatJid, flow, serverName).length;
}

function latestRateLimitForChat(text, chatJid) {
  const entries = flowEntriesForChat(text, chatJid, 'model.rate_limit');
  const latest = entries[entries.length - 1]?.context;
  if (!latest) return null;
  return {
    status: latest.status ?? null,
    utilization: latest.utilization ?? null,
    type: latest.rateLimitType ?? null,
  };
}

function firstFlowTimeForChat(text, chatJid, flow, serverName) {
  for (const entry of flowEntriesForChat(text, chatJid, flow, serverName)) {
    const ms = eventTimeMs(entry);
    if (ms !== null) return ms;
  }
  return null;
}

function hasLogMessageForChat(text, chatJid, message) {
  return parseJsonLogLines(text).some(
    (entry) =>
      entry?.message === message &&
      logContextMatchesChat(entry?.context, chatJid),
  );
}

async function waitFor(label, offset, predicate, timeoutMs = TURN_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = readLogsSince(offset);
    if (predicate(last)) return last;
    await sleep(POLL_MS);
  }
  throw new Error(
    `timed out waiting for ${label}\nlast log:\n${last.slice(-4000)}`,
  );
}

async function health(url, label) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  const text = await response.text();
  if (label === 'core') return response.status;
  if (!response.ok || !text.includes('"ok":true')) {
    throw new Error(`${label} health failed: HTTP ${response.status} ${text}`);
  }
  return response.status;
}

async function runtimeWorkersHealth() {
  if (!smokeEnv.controlToken) {
    throw new Error(
      'missing GANTRY_SMOKE_CONTROL_TOKEN; start the stack with npm run dev:boondi-runtime and run the printed GANTRY_RUNTIME_SMOKE_ENV command',
    );
  }
  const response = await fetch(
    `http://127.0.0.1:${CORE_PORT}${RUNTIME_WORKERS_PATH}`,
    {
      headers: {
        Authorization: `Bearer ${smokeEnv.controlToken}`,
      },
      signal: AbortSignal.timeout(3_000),
    },
  );
  const workerInventory = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `/v1/runtime/workers failed: HTTP ${response.status} ${JSON.stringify(workerInventory)}`,
    );
  }
  if (
    !workerInventory ||
    !Array.isArray(workerInventory.instances) ||
    workerInventory.healthyTotals.instances < 1
  ) {
    throw new Error(
      `/v1/runtime/workers returned invalid inventory: ${JSON.stringify(workerInventory)}`,
    );
  }
  if (
    workerInventory.instances.length < smokeEnv.expectedRuntimeInstances ||
    workerInventory.healthyTotals.instances < smokeEnv.expectedRuntimeInstances
  ) {
    throw new Error(
      `/v1/runtime/workers did not expose ${smokeEnv.expectedRuntimeInstances} healthy runtime instances: ${JSON.stringify(workerInventory)}`,
    );
  }
  return workerInventory;
}

function warmWorkerRss() {
  let pids = [];
  try {
    pids = execFileSync('ps', ['-axo', 'pid=,command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('--gantry-warm-pool-worker='))
      .map((line) => line.split(/\s+/, 1)[0])
      .filter(Boolean);
  } catch {
    pids = [];
  }
  const workers = pids.flatMap((pid) => {
    try {
      const rssKb = Number(
        execFileSync('ps', ['-p', pid, '-o', 'rss='], {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .trim(),
      );
      if (!Number.isFinite(rssKb)) return [];
      return [{ pid, rssKb }];
    } catch {
      return [];
    }
  });
  return {
    count: workers.length,
    totalRssKb: workers.reduce((acc, worker) => acc + worker.rssKb, 0),
    maxRssKb: workers.length
      ? Math.max(...workers.map((worker) => worker.rssKb))
      : 0,
    workers,
  };
}

async function sendCheckedWebhook(input) {
  const result = await sendWebhook({ ...input, port: CORE_PORT });
  if (!result.ok) {
    throw new Error(
      `${input.from} webhook rejected: HTTP ${result.status} ${result.response}`,
    );
  }
  return result;
}

async function runCase(smokeCase) {
  const chatJid = `wa:${smokeCase.phone}`;

  let offset = logOffsets();
  await sendCheckedWebhook({
    from: smokeCase.phone,
    text: '/new',
    name: 'Runtime Smoke',
  });
  await waitFor(
    `${smokeCase.name} reset outbound`,
    offset,
    (text) =>
      text.includes(chatJid) && text.includes('Started a fresh session.'),
    60_000,
  );

  offset = logOffsets();
  const firstTurn = await sendCheckedWebhook({
    from: smokeCase.phone,
    text: smokeCase.text,
    name: 'Runtime Smoke',
  });
  const turnSentAt = Date.now();

  const finalLog = await waitFor(
    `${smokeCase.name} MCP response and outbound`,
    offset,
    (text) =>
      hasFlowForChat(text, chatJid, 'guardrail') &&
      (smokeCase.expectAgentMcpFlow === false ||
        (hasFlowForChat(text, chatJid, 'mcp.request', smokeCase.serverName) &&
          hasFlowForChat(
            text,
            chatJid,
            'mcp.response',
            smokeCase.serverName,
          ))) &&
      hasFlowForChat(text, chatJid, 'outbound') &&
      hasLogMessageForChat(
        text,
        chatJid,
        'Outbound dry-run: sent to listed test number',
      ),
  );
  const outboundAt = firstFlowTimeForChat(finalLog, chatJid, 'outbound');
  const replyMs = outboundAt === null ? null : outboundAt - turnSentAt;

  const duplicateOffset = logOffsets();
  await sendCheckedWebhook({
    from: smokeCase.phone,
    text: smokeCase.text,
    name: 'Runtime Smoke',
    messageId: firstTurn.messageId,
  });
  await sleep(DUPLICATE_SETTLE_MS);
  const duplicateLog = readLogsSince(duplicateOffset);
  const duplicateRuntimeWork =
    hasFlowForChat(duplicateLog, chatJid, 'guardrail') ||
    hasFlowForChat(
      duplicateLog,
      chatJid,
      'mcp.request',
      smokeCase.serverName,
    ) ||
    hasFlowForChat(
      duplicateLog,
      chatJid,
      'mcp.response',
      smokeCase.serverName,
    ) ||
    hasFlowForChat(duplicateLog, chatJid, 'outbound');
  if (duplicateRuntimeWork) {
    throw new Error(
      `${smokeCase.name} duplicate inbound produced runtime work\n${duplicateLog.slice(-4000)}`,
    );
  }

  return {
    name: smokeCase.name,
    phone: smokeCase.phone,
    serverName: smokeCase.serverName,
    guardrail: countFlowForChat(finalLog, chatJid, 'guardrail'),
    mcpRequest: countFlowForChat(
      finalLog,
      chatJid,
      'mcp.request',
      smokeCase.serverName,
    ),
    mcpResponse: countFlowForChat(
      finalLog,
      chatJid,
      'mcp.response',
      smokeCase.serverName,
    ),
    outbound: countFlowForChat(finalLog, chatJid, 'outbound'),
    duplicateInbound: true,
    replyMs,
    modelRateLimit: latestRateLimitForChat(finalLog, chatJid),
  };
}

async function main() {
  await health(`http://127.0.0.1:${CORE_PORT}/`, 'core');
  await health('http://127.0.0.1:8081/healthz', 'shopify-api');
  await health('http://127.0.0.1:8082/healthz', 'boondi-crm');
  const workerInventoryBefore = await runtimeWorkersHealth();
  const warmWorkerRssBefore = warmWorkerRss();

  const results = await mapPool(smokeCases, SMOKE_CONCURRENCY, runCase);
  const workerInventoryAfter = await runtimeWorkersHealth();
  const warmWorkerRssAfter = warmWorkerRss();
  console.log(
    JSON.stringify(
      {
        ok: true,
        concurrency: SMOKE_CONCURRENCY,
        caseCount: smokeCases.length,
        workerInventory: {
          before: workerInventoryBefore.healthyTotals,
          after: workerInventoryAfter.healthyTotals,
        },
        warmWorkerRss: {
          before: warmWorkerRssBefore,
          after: warmWorkerRssAfter,
        },
        results,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
