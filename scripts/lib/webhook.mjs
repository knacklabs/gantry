// Inject a signed Interakt webhook into the locally running Gantry dev server.
// Verification has no bypass, so each message
// carries a fresh HMAC over its exact body bytes. The webhook ACKs immediately and
// processes asynchronously; callers read the GANTRY_FLOW_LOG to see what happened.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ALL_TEST_PHONES } from './phones.mjs';

const GANTRY_HOME = process.env.GANTRY_HOME || path.join(os.homedir(), 'gantry');
const DEFAULT_PORT = Number(process.env.GANTRY_CONTROL_PORT || 4710);
// A fake default — real numbers are never used as test senders (they'd receive sends).
const DEFAULT_FROM = '919900050001';

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
  if (!ALL_TEST_PHONES.includes(from) && process.env.BOONDI_ALLOW_UNLISTED_TEST_PHONE !== '1') {
    throw new Error(
      `refusing to send signed test webhook from unlisted phone ${from}; add it to scripts/lib/phones.mjs or set BOONDI_ALLOW_UNLISTED_TEST_PHONE=1`,
    );
  }
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
