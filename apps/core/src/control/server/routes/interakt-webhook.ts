import type { IncomingMessage, ServerResponse } from 'node:http';

import { getLiveInteraktChannel } from '../../../channels/interakt/interakt-instance-registry.js';
import { verifyInteraktSignature } from '../../../channels/interakt/interakt-webhook-signature.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import type { ControlRouteContext } from '../handler-context.js';
import { readRawBody, sendError, sendJson } from '../http.js';

const PATH = '/v1/channels/interakt/webhook';
// Interakt payloads are small; cap at 64 KiB to avoid abuse.
const MAX_BODY_BYTES = 64 * 1024;

export async function handleInteraktWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname !== PATH) return false;
  if (req.method !== 'POST') {
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST');
    return true;
  }

  // Auth is the HMAC signature on the raw body — no Gantry control API key.
  const channel = getLiveInteraktChannel();
  if (!channel) {
    sendError(
      res,
      503,
      'CHANNEL_NOT_CONNECTED',
      'Interakt channel is not enabled in this runtime',
    );
    return true;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, MAX_BODY_BYTES);
    // eslint-disable-next-line no-catch-all/no-catch-all -- HTTP route boundary translates body read failures to a stable 4xx response.
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode ?? 400;
    sendError(res, status, 'BAD_REQUEST', (err as Error).message);
    return true;
  }

  // Node lowercases header names. Interakt's docs use mixed casing in
  // different places, so accept both with and without the X- prefix.
  const sigHeader =
    (req.headers['interakt-signature'] as string | undefined) ??
    (req.headers['x-interakt-signature'] as string | undefined);
  if (
    !verifyInteraktSignature(rawBody, sigHeader, channel.getWebhookSecret())
  ) {
    logger.warn({ path: pathname }, 'Interakt webhook signature mismatch');
    sendError(res, 401, 'INVALID_SIGNATURE', 'Signature did not match');
    return true;
  }

  // Interakt's SLA: ACK 200 within 3s; no retries; 5 failures in 10min
  // disables the webhook. ACK first, do work after.
  sendJson(res, 200, { ok: true });
  setImmediate(() => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
      // eslint-disable-next-line no-catch-all/no-catch-all -- Webhook ACK already succeeded; malformed JSON must be logged and dropped.
    } catch {
      logger.warn({ path: pathname }, 'Interakt webhook body was not JSON');
      return;
    }
    void channel
      .handleWebhookEvent(parsed)
      .catch((err) => logger.error({ err }, 'Interakt webhook handler failed'));
  });
  return true;
}
