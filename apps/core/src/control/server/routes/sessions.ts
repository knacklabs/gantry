import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { NewMessage } from '../../../domain/types.js';
import { getRuntimeOpsRepository } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeControlRepository } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeEventExchange } from '../../../adapters/storage/postgres/runtime-store.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { RuntimeEvent } from '../../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../../domain/events/runtime-event-types.js';
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
    const visibleProviderSession = providerSession
      ? {
          id: providerSession.id,
          appId: providerSession.appId,
          agentSessionId: providerSession.agentSessionId,
          provider: providerSession.provider,
          externalSessionId: providerSession.externalSessionId,
          providerRef: providerSession.providerRef,
          status: providerSession.status,
          metadata: providerSession.metadata,
          createdAt: providerSession.createdAt,
          updatedAt: providerSession.updatedAt,
        }
      : null;
    sendJson(res, 200, {
      session,
      providerSession: visibleProviderSession,
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
    const accepted = await getRuntimeEventExchange().publish({
      appId: session.appId as never,
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      payload: {
        messageId,
        text,
        threadId: threadId || null,
      },
      actor: 'sdk',
      sessionId: session.sessionId as never,
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
    const runtimeEvents = getRuntimeEventExchange();
    const session = await control.getAppSessionById(sessionRoute.sessionId);
    if (!session) {
      sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
      return true;
    }
    if (!canAccessApp(auth, session.appId)) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this session');
      return true;
    }
    const events = await runtimeEvents.list({
      appId: session.appId as never,
      sessionId: session.sessionId as never,
      afterEventId: afterEventId > 0 ? (afterEventId as never) : undefined,
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
        writeSseEvent(res, event);
      }
      let lastEventId = initial[initial.length - 1]?.eventId;
      const subscription = runtimeEvents.subscribe({
        appId: session.appId as never,
        sessionId: session.sessionId as never,
        afterEventId:
          lastEventId ??
          (afterEventId > 0 ? (afterEventId as never) : undefined),
        limit: 100,
      });
      let closed = false;
      const pump = async () => {
        while (!closed) {
          try {
            const next = await subscription.next({ timeoutMs: 30_000 });
            for (const event of next) {
              lastEventId = event.eventId;
              writeSseEvent(res, event);
            }
          } catch (error) {
            logger.warn(
              { err: error, sessionId: session.sessionId },
              'Failed streaming runtime events',
            );
            await delay(1000);
          }
        }
      };
      void pump();
      req.on('close', () => {
        closed = true;
        subscription.close();
        ctx.state.activeStreams = Math.max(0, ctx.state.activeStreams - 1);
      });
      return true;
    }
    sendJson(res, 200, {
      events: events.map((event) => ({
        eventId: event.eventId,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
    });
    return true;
  }

  if (sessionRoute?.action === 'wait' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const control = getRuntimeControlRepository();
    const runtimeEvents = getRuntimeEventExchange();
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
    const subscription = runtimeEvents.subscribe({
      appId: session.appId as never,
      sessionId: session.sessionId as never,
      afterEventId: afterEventId > 0 ? (afterEventId as never) : undefined,
      limit: 100,
    });
    try {
      while (Date.now() - startedAt < timeoutMs) {
        const remaining = timeoutMs - (Date.now() - startedAt);
        const events = await subscription.next({ timeoutMs: remaining });
        const visible = events.find(isVisibleWaitEvent);
        if (visible) {
          sendJson(res, 200, {
            eventId: visible.eventId,
            eventType: visible.eventType,
            payload: visible.payload,
            createdAt: visible.createdAt,
            afterEventId: visible.eventId,
          });
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } finally {
      subscription.close();
      ctx.state.activeWaits = Math.max(0, ctx.state.activeWaits - 1);
    }
    sendError(res, 408, 'WAIT_TIMEOUT', 'Timed out waiting for session event');
    return true;
  }

  return false;
}

function writeSseEvent(res: ServerResponse, event: RuntimeEvent): void {
  res.write(`id: ${event.eventId}\n`);
  res.write(`event: ${sanitizeSseEventType(event.eventType)}\n`);
  res.write(`data: ${JSON.stringify(event.payload)}\n\n`);
}

function sanitizeSseEventType(eventType: string): string {
  return /^[a-z0-9._-]+$/.test(eventType) ? eventType : 'runtime_event';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isVisibleWaitEvent(event: RuntimeEvent): boolean {
  return (
    event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_OUTBOUND ||
    event.eventType === RUNTIME_EVENT_TYPES.SESSION_MESSAGE_STREAMING
  );
}

function parseListLimit(raw: string | null): number {
  if (raw === null || raw === '') return 100;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}
