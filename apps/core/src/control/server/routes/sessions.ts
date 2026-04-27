import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { NewMessage } from '../../../domain/types.js';
import { getRuntimeOpsRepository } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeControlRepository } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { makeThreadQueueKey } from '../../../runtime/thread-queue-key.js';
import {
  canAccessApp,
  makeAppGroup,
  nowIso,
  resolveOwnedWebhookId,
} from '../app-identity.js';
import { isValidControlId } from '../auth.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { parseSessionRoute } from '../route-parser.js';

export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/sessions/ensure' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'sessions:write',
    ]);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const appId = String(body.appId || '').trim();
    const conversationId = String(body.conversationId || '').trim();
    if (!appId || !conversationId) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'appId and conversationId are required',
      );
      return true;
    }
    if (!isValidControlId(appId) || !isValidControlId(conversationId)) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'appId and conversationId must contain only letters, numbers, dot, underscore, or dash',
      );
      return true;
    }
    if (!canAccessApp(auth, appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this app');
      return true;
    }
    const chatJid = `app:${appId}:${conversationId}`;
    const control = getRuntimeControlRepository();
    const defaultWebhookId = await resolveOwnedWebhookId(
      control,
      auth.appId,
      typeof body.webhookId === 'string' ? body.webhookId : null,
    );
    const group = makeAppGroup({ appId, conversationId, chatJid });
    await ctx.app.registerGroup(chatJid, group);
    const session = await control.ensureAppSession({
      appId,
      conversationId,
      chatJid,
      groupFolder: group.folder,
      title: typeof body.title === 'string' ? body.title : null,
      defaultResponseMode:
        body.responseMode === 'webhook' ||
        body.responseMode === 'both' ||
        body.responseMode === 'none'
          ? (body.responseMode as 'webhook' | 'both' | 'none')
          : 'sse',
      defaultWebhookId,
    });
    sendJson(res, 200, {
      sessionId: session.sessionId,
      appId: session.appId,
      conversationId: session.conversationId,
      chatJid: session.chatJid,
    });
    return true;
  }

  const sessionRoute = parseSessionRoute(pathname);
  if (sessionRoute?.action === 'get' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const repositories = getRuntimeStorage().repositories;
    const session = await repositories.agentSessions.getAgentSession(
      sessionRoute.sessionId as never,
    );
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
      return true;
    }
    if (!canAccessApp(auth, session.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    const providerSession =
      await repositories.providerSessions.getLatestProviderSession({
        agentSessionId: session.id,
      });
    sendJson(res, 200, {
      session,
      providerSession: providerSession
        ? { ...providerSession, artifactRef: undefined }
        : null,
    });
    return true;
  }

  if (sessionRoute?.action === 'messages' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const repositories = getRuntimeStorage().repositories;
    const session = await repositories.agentSessions.getAgentSession(
      sessionRoute.sessionId as never,
    );
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
      return true;
    }
    if (!canAccessApp(auth, session.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    if (!session.conversationId) {
      sendJson(res, 200, { messages: [] });
      return true;
    }
    const limit = parseListLimit(url.searchParams.get('limit'));
    const messages = await repositories.messages.listRecentMessages({
      conversationId: session.conversationId,
      threadId: session.threadId,
      limit,
    });
    sendJson(res, 200, { messages });
    return true;
  }

  if (sessionRoute?.action === 'runs' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const repositories = getRuntimeStorage().repositories;
    const session = await repositories.agentSessions.getAgentSession(
      sessionRoute.sessionId as never,
    );
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
      return true;
    }
    if (!canAccessApp(auth, session.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    const limit = parseListLimit(url.searchParams.get('limit'));
    const runs = await repositories.agentRuns.listAgentRunsBySession({
      sessionId: session.id,
      limit,
    });
    sendJson(res, 200, { runs });
    return true;
  }

  if (sessionRoute?.action === 'messages' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'sessions:write',
    ]);
    if (!auth) return true;
    const control = getRuntimeControlRepository();
    const session = await control.getAppSessionById(sessionRoute.sessionId);
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
      return true;
    }
    if (!canAccessApp(auth, session.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    const body = (await readJson(req)) as Record<string, unknown>;
    const text = String(body.message || '').trim();
    if (!text) {
      sendError(res, 400, 'INVALID_REQUEST', 'message is required');
      return true;
    }
    const now = nowIso();
    const threadId =
      typeof body.threadId === 'string' ? body.threadId.trim() : '';
    const responseMode =
      body.responseMode === 'webhook' ||
      body.responseMode === 'both' ||
      body.responseMode === 'none'
        ? (body.responseMode as 'webhook' | 'both' | 'none')
        : session.defaultResponseMode;
    const webhookId = await resolveOwnedWebhookId(
      control,
      auth.appId,
      typeof body.webhookId === 'string'
        ? body.webhookId
        : session.defaultWebhookId,
    );
    const messageId = randomUUID();
    const message: NewMessage = {
      id: messageId,
      chat_jid: session.chatJid,
      channel_provider: 'app',
      sender: typeof body.senderId === 'string' ? body.senderId : 'sdk',
      sender_name:
        typeof body.senderName === 'string' ? body.senderName : 'SDK',
      content: text,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
      external_message_id: messageId,
      thread_id: threadId || undefined,
    };
    const ops = getRuntimeOpsRepository();
    await ops.storeChatMetadata(
      session.chatJid,
      now,
      session.title ?? session.chatJid,
      'app',
      true,
    );
    await ops.storeMessage(message);
    const correlationId =
      typeof body.correlationId === 'string' ? body.correlationId : null;
    await control.upsertAppResponseRoute({
      sessionId: session.sessionId,
      threadId: threadId || null,
      responseMode,
      webhookId,
      correlationId,
    });
    const accepted = await control.addControlEvent({
      eventType: 'session.message.inbound',
      payload: JSON.stringify({
        messageId,
        text,
        threadId: threadId || null,
      }),
      actor: 'sdk',
      sessionId: session.sessionId,
      correlationId,
      responseMode,
      webhookId,
    });
    ctx.app.queue.enqueueMessageCheck(
      makeThreadQueueKey(session.chatJid, threadId || null),
    );
    sendJson(res, 202, {
      accepted: true,
      messageId,
      acceptedEventId: accepted.eventId,
    });
    return true;
  }

  if (sessionRoute?.action === 'events' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const afterEventId = Number(url.searchParams.get('afterEventId') || 0);
    const control = getRuntimeControlRepository();
    const session = await control.getAppSessionById(sessionRoute.sessionId);
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
      return true;
    }
    if (!canAccessApp(auth, session.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    const events = await control.listSessionEvents({
      sessionId: session.sessionId,
      afterEventId: afterEventId > 0 ? afterEventId : undefined,
      limit: 100,
    });
    if (req.headers.accept?.includes('text/event-stream')) {
      if (ctx.state.activeStreams >= ctx.maxConcurrentStreams) {
        sendError(
          res,
          429,
          'TOO_MANY_STREAMS',
          'Too many active event streams',
        );
        return true;
      }
      ctx.state.activeStreams += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      const initial = events.length > 0 ? events : [];
      for (const event of initial) {
        res.write(`id: ${event.eventId}\n`);
        res.write(`event: ${event.eventType}\n`);
        res.write(`data: ${event.payload}\n\n`);
      }
      let lastEventId = initial[initial.length - 1]?.eventId ?? afterEventId;
      let pollInFlight = false;
      const interval = setInterval(async () => {
        if (pollInFlight) return;
        pollInFlight = true;
        try {
          const next = await control.listSessionEvents({
            sessionId: session.sessionId,
            afterEventId: lastEventId > 0 ? lastEventId : undefined,
            limit: 100,
          });
          for (const event of next) {
            lastEventId = event.eventId;
            res.write(`id: ${event.eventId}\n`);
            res.write(`event: ${event.eventType}\n`);
            res.write(`data: ${event.payload}\n\n`);
          }
        } catch (error) {
          logger.warn(
            { err: error, sessionId: session.sessionId },
            'Failed polling control events',
          );
        } finally {
          pollInFlight = false;
        }
      }, 1000);
      req.on('close', () => {
        clearInterval(interval);
        ctx.state.activeStreams = Math.max(0, ctx.state.activeStreams - 1);
      });
      return true;
    }
    sendJson(res, 200, {
      events: events.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        payload: JSON.parse(event.payload),
        createdAt: event.createdAt,
      })),
    });
    return true;
  }

  if (sessionRoute?.action === 'wait' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const control = getRuntimeControlRepository();
    const session = await control.getAppSessionById(sessionRoute.sessionId);
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
      return true;
    }
    if (!canAccessApp(auth, session.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    if (ctx.state.activeWaits >= ctx.maxConcurrentWaits) {
      sendError(res, 429, 'TOO_MANY_WAITS', 'Too many active wait requests');
      return true;
    }
    ctx.state.activeWaits += 1;
    const afterEventId = Number(url.searchParams.get('afterEventId') || 0);
    const timeoutMs = Math.min(
      300_000,
      Math.max(1000, Number(url.searchParams.get('timeoutMs') || 60_000)),
    );
    const startedAt = Date.now();
    let cursor = afterEventId;
    try {
      while (Date.now() - startedAt < timeoutMs) {
        const events = await control.listSessionEvents({
          sessionId: session.sessionId,
          afterEventId: cursor > 0 ? cursor : undefined,
          limit: 100,
        });
        if (events.length > 0) {
          cursor = events[events.length - 1]!.eventId;
        }
        const visible = events.find(
          (event) =>
            event.eventType === 'session.message.outbound' ||
            event.eventType === 'session.message.streaming',
        );
        if (visible) {
          sendJson(res, 200, {
            eventId: visible.eventId,
            eventType: visible.eventType,
            payload: JSON.parse(visible.payload),
            createdAt: visible.createdAt,
          });
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      ctx.state.activeWaits = Math.max(0, ctx.state.activeWaits - 1);
    }
    sendError(res, 408, 'WAIT_TIMEOUT', 'Timed out waiting for session event');
    return true;
  }

  return false;
}

function parseListLimit(raw: string | null): number {
  if (raw === null || raw === '') return 100;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}
