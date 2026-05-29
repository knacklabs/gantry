#!/usr/bin/env node
// Inject a signed Interakt webhook into the locally running Gantry dev server.
//
// Verification has no bypass, so each message must carry a fresh HMAC over its
// exact body bytes — that is why this is a script and not a static curl. The
// webhook ACKs immediately and processes asynchronously, so callers that need
// the reply should read the dev logfile (see interakt-test-run.mjs).
//
// Usage:
//   node scripts/interakt-test-send.mjs --text "What was my last order?"
//   node scripts/interakt-test-send.mjs --new                 # reset the session
//   node scripts/interakt-test-send.mjs --text "hi" --from 919654405340
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const GANTRY_HOME = process.env.GANTRY_HOME || path.join(os.homedir(), 'gantry');
const DEFAULT_PORT = Number(process.env.GANTRY_CONTROL_PORT || 4710);
// The real WhatsApp number Interakt would send (dev's own number). The Shopify
// caller-identity override (test number) is applied server-side via env, not here.
const DEFAULT_FROM = '919654405340';

function readEnvSecret(name) {
  const envPath = path.join(GANTRY_HOME, '.env');
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[1] === name) {
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  throw new Error(`${name} not found in ${envPath}`);
}

export async function sendWebhook({
  text,
  from = DEFAULT_FROM,
  port = DEFAULT_PORT,
  name = 'Test Customer',
  messageId = crypto.randomUUID(),
}) {
  const secret = readEnvSecret('INTERAKT_WEBHOOK_SECRET');
  const iso = new Date().toISOString();
  const payload = {
    version: '1.0',
    timestamp: iso,
    type: 'message_received',
    data: {
      customer: { channel_phone_number: from, traits: { name } },
      message: {
        id: messageId,
        chat_message_type: 'CustomerMessage',
        message_content_type: 'Text',
        message: text,
        received_at_utc: iso,
      },
    },
  };
  // Sign the exact bytes we send — the server verifies HMAC over the raw body.
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const url = `http://127.0.0.1:${port}/v1/channels/interakt/webhook`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Interakt-Signature': `sha256=${sig}`,
    },
    body,
  });
  return {
    status: res.status,
    ok: res.ok,
    messageId,
    chatJid: `wa:${from}`,
    response: await res.text(),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--new') out.text = '/new';
    else if (a === '--text') out.text = argv[++i];
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--id') out.messageId = argv[++i];
  }
  return out;
}

const isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.text) {
    console.error('Provide --text "<message>" (or --new to reset the session).');
    process.exit(2);
  }
  sendWebhook(args)
    .then((r) => {
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`send failed: ${err.message}`);
      process.exit(1);
    });
}
