import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { getRuntimeControlRepository } from '../../../adapters/storage/postgres/runtime-store.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { parseWebhookRoute } from '../route-parser.js';
import { validateWebhookTarget } from '../webhook-target.js';

export async function handleWebhookRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/webhooks' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'webhooks:write',
    ]);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const name = String(body.name || '').trim();
    const rawTargetUrl = String(body.url || '').trim();
    const secret = String(body.secret || '').trim() || randomUUID();
    if (!name || !rawTargetUrl) {
      sendError(res, 400, 'INVALID_REQUEST', 'name and url are required');
      return true;
    }
    const targetUrl = await validateWebhookTarget(rawTargetUrl);
    const webhook = await getRuntimeControlRepository().registerWebhook({
      appId: auth.appId,
      name,
      url: targetUrl.url.toString(),
      secret,
      enabled: body.enabled !== false,
    });
    sendJson(res, 201, webhook);
    return true;
  }

  if (pathname === '/v1/webhooks' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['webhooks:read']);
    if (!auth) return true;
    sendJson(res, 200, {
      webhooks: await getRuntimeControlRepository().listWebhooks(auth.appId),
    });
    return true;
  }

  const webhookRoute = parseWebhookRoute(pathname);
  if (webhookRoute?.action === 'delete' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'webhooks:write',
    ]);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const patch: {
      name?: string;
      url?: string;
      secret?: string;
      enabled?: boolean;
    } = {};
    if ('name' in body) {
      const name = String(body.name || '').trim();
      if (!name) {
        sendError(res, 400, 'INVALID_REQUEST', 'name cannot be empty');
        return true;
      }
      patch.name = name;
    }
    if ('url' in body) {
      const rawTargetUrl = String(body.url || '').trim();
      if (!rawTargetUrl) {
        sendError(res, 400, 'INVALID_REQUEST', 'url cannot be empty');
        return true;
      }
      const targetUrl = await validateWebhookTarget(rawTargetUrl);
      patch.url = targetUrl.url.toString();
    }
    if ('secret' in body) {
      const secret = String(body.secret || '').trim();
      if (!secret) {
        sendError(res, 400, 'INVALID_REQUEST', 'secret cannot be empty');
        return true;
      }
      patch.secret = secret;
    }
    if ('enabled' in body) {
      patch.enabled = body.enabled !== false;
    }
    const webhook = await getRuntimeControlRepository().updateWebhook(
      webhookRoute.webhookId,
      auth.appId,
      patch,
    );
    if (!webhook) {
      sendError(res, 404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
      return true;
    }
    sendJson(res, 200, webhook);
    return true;
  }

  if (webhookRoute?.action === 'delete' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'webhooks:write',
    ]);
    if (!auth) return true;
    await getRuntimeControlRepository().deleteWebhook(
      webhookRoute.webhookId,
      auth.appId,
    );
    sendJson(res, 200, { deleted: true });
    return true;
  }

  if (webhookRoute?.action === 'replay-dead-letter' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'webhooks:write',
    ]);
    if (!auth) return true;
    const existing = await getRuntimeControlRepository().getWebhookById(
      webhookRoute.webhookId,
      auth.appId,
    );
    if (!existing) {
      sendError(res, 404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
      return true;
    }
    const replayed =
      await getRuntimeControlRepository().replayWebhookDeadLetters(
        webhookRoute.webhookId,
        auth.appId,
      );
    sendJson(res, 200, { replayed });
    return true;
  }

  if (webhookRoute?.action === 'purge-dead-letter' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'webhooks:write',
    ]);
    if (!auth) return true;
    const existing = await getRuntimeControlRepository().getWebhookById(
      webhookRoute.webhookId,
      auth.appId,
    );
    if (!existing) {
      sendError(res, 404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
      return true;
    }
    const purged = await getRuntimeControlRepository().purgeWebhookDeadLetters(
      webhookRoute.webhookId,
      auth.appId,
    );
    sendJson(res, 200, { purged });
    return true;
  }

  if (webhookRoute?.action === 'test' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'webhooks:write',
    ]);
    if (!auth) return true;
    const control = getRuntimeControlRepository();
    const webhook = await control.getWebhookById(
      webhookRoute.webhookId,
      auth.appId,
    );
    if (!webhook) {
      sendError(res, 404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
      return true;
    }
    const event = await control.addControlEvent({
      eventType: 'webhook.test',
      payload: JSON.stringify({ ok: true, webhookId: webhook.webhookId }),
      actor: 'sdk',
      responseMode: 'webhook',
      webhookId: webhook.webhookId,
    });
    sendJson(res, 202, { accepted: true, eventId: event.eventId });
    return true;
  }

  return false;
}
