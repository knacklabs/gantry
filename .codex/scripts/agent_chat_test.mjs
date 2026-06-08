#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_TIMEOUT_MS = 300_000;

function usage() {
  return `Usage:
  node .codex/scripts/agent_chat_test.mjs "message" [options]

Options:
  --runtime-home <path>       Runtime home. Default: ~/gantry
  --conversation-id <id>      App conversation id. Default: codex-test
  --thread-id <id>            Optional thread id
  --sender-id <id>            Sender id. Default: codex-test
  --sender-name <name>        Sender name. Default: Codex Test
  --timeout-ms <ms>           Wait timeout. Default: 300000
  --fresh                     Append a timestamp to conversation id
  --json                      Print a JSON result
  --help                      Show this help

This sends through Gantry's app/session Control API. It tests the real runtime
queue and event flow, but it does not exercise Telegram button rendering.`;
}

function parseArgs(argv) {
  const args = {
    runtimeHome: path.join(process.env.HOME || '', 'gantry'),
    conversationId: 'codex-test',
    threadId: undefined,
    senderId: 'codex-test',
    senderName: 'Codex Test',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    fresh: false,
    json: false,
    message: '',
  };
  const positionals = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (!argv[i]) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg === '--runtime-home') args.runtimeHome = next();
    else if (arg === '--conversation-id') args.conversationId = next();
    else if (arg === '--thread-id') args.threadId = next();
    else if (arg === '--sender-id') args.senderId = next();
    else if (arg === '--sender-name') args.senderName = next();
    else if (arg === '--timeout-ms') args.timeoutMs = parseTimeout(next());
    else if (arg === '--fresh') args.fresh = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    else positionals.push(arg);
  }
  args.message = positionals.join(' ').trim();
  if (!args.message) throw new Error('message is required');
  if (args.fresh) {
    args.conversationId = `${args.conversationId}-${new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)}`;
  }
  assertControlId(args.conversationId, 'conversation id');
  return args;
}

function parseTimeout(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new Error('--timeout-ms must be a number >= 1000');
  }
  return Math.min(DEFAULT_TIMEOUT_MS, Math.floor(parsed));
}

function assertControlId(value, label) {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, dot, underscore, or dash`);
  }
}

function readRuntimeEnv(runtimeHome) {
  return {
    ...readEnvFile(path.join(runtimeHome, '.env')),
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
    ),
  };
}

function readEnvFile(filePath) {
  try {
    const env = {};
    for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function controlApiKey(env) {
  const rawJson = env.GANTRY_CONTROL_API_KEYS_JSON?.trim();
  if (!rawJson) return '';
  const parsed = JSON.parse(rawJson);
  if (!Array.isArray(parsed)) return '';
  const entry = parsed.find(
    (item) =>
      item &&
      typeof item === 'object' &&
      typeof item.token === 'string' &&
      Array.isArray(item.scopes) &&
      item.scopes.includes('sessions:read') &&
      item.scopes.includes('sessions:write'),
  );
  return entry?.token?.trim() || '';
}

function controlBaseUrl(env) {
  if (env.GANTRY_CONTROL_BASE_URL?.trim()) return env.GANTRY_CONTROL_BASE_URL.trim();
  const port = Number(env.GANTRY_CONTROL_PORT || 0);
  return port > 0 ? `http://127.0.0.1:${port}` : 'http://127.0.0.1';
}

function controlSocketPath(runtimeHome, env) {
  if (env.GANTRY_CONTROL_BASE_URL?.trim()) return undefined;
  if (Number(env.GANTRY_CONTROL_PORT || 0) > 0) return undefined;
  return env.GANTRY_CONTROL_SOCKET_PATH?.trim() || path.join(runtimeHome, 'run', 'control.sock');
}

async function requestJson(client, method, requestPath, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const url = new URL(requestPath, client.baseUrl);
  const mod = url.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: client.socketPath ? undefined : url.hostname,
        port: client.socketPath ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        socketPath: client.socketPath,
        method,
        headers: {
          authorization: `Bearer ${client.apiKey}`,
          accept: 'application/json',
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': String(payload.byteLength),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const parsed = parseJson(Buffer.concat(chunks).toString('utf8'));
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(errorMessage(parsed)));
            return;
          }
          resolve(parsed);
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(raw) {
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function errorMessage(input) {
  return input?.error?.message || 'Gantry request failed';
}

function textFromEvent(event) {
  const text = event?.payload?.text;
  return typeof text === 'string' ? text : '';
}

async function main() {
  const args = parseArgs(process.argv);
  const env = readRuntimeEnv(args.runtimeHome);
  const apiKey = controlApiKey(env);
  if (!apiKey) {
    throw new Error(
      'GANTRY_CONTROL_API_KEYS_JSON needs a key with sessions:read and sessions:write',
    );
  }
  const client = {
    apiKey,
    baseUrl: controlBaseUrl(env),
    socketPath: controlSocketPath(args.runtimeHome, env),
  };
  const ensured = await requestJson(client, 'POST', '/v1/sessions/ensure', {
    conversationId: args.conversationId,
    title: 'Codex Agent Chat Test',
    responseMode: 'sse',
  });
  const correlationId = `codex-test-${Date.now()}`;
  const accepted = await requestJson(
    client,
    'POST',
    `/v1/sessions/${encodeURIComponent(ensured.sessionId)}/messages`,
    {
      message: args.message,
      senderId: args.senderId,
      senderName: args.senderName,
      threadId: args.threadId,
      correlationId,
      responseMode: 'sse',
    },
  );

  const startedAt = Date.now();
  let afterEventId = accepted.acceptedEventId || 0;
  const seenEvents = [];
  const assistantTexts = [];
  while (Date.now() - startedAt < args.timeoutMs) {
    const remaining = Math.max(1000, args.timeoutMs - (Date.now() - startedAt));
    let event;
    try {
      event = await requestJson(
        client,
        'GET',
        `/v1/sessions/${encodeURIComponent(ensured.sessionId)}/wait?afterEventId=${encodeURIComponent(
          String(afterEventId),
        )}&timeoutMs=${encodeURIComponent(String(Math.min(remaining, DEFAULT_TIMEOUT_MS)))}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('Timed out waiting')) break;
      throw error;
    }
    if (event?.eventId) afterEventId = event.eventId;
    if (event?.eventType) seenEvents.push(event);
    const text = textFromEvent(event);
    if (text) assistantTexts.push(text);
    if (event?.eventType === 'session.message.outbound') break;
  }

  const result = {
    sessionId: ensured.sessionId,
    conversationId: ensured.conversationId,
    chatJid: ensured.chatJid,
    messageId: accepted.messageId,
    acceptedEventId: accepted.acceptedEventId,
    responseEventIds: seenEvents.map((event) => event.eventId),
    response: assistantTexts.join(''),
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Session: ${result.sessionId}`);
  console.log(`Conversation: ${result.conversationId}`);
  console.log(`Accepted message: ${result.messageId}`);
  console.log('');
  console.log(result.response || '(no assistant response before timeout)');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
