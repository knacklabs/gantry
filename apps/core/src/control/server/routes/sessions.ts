import type { IncomingMessage, ServerResponse } from 'node:http';
import { CreateSessionRequestSchema } from '@gantry/contracts';
import { Ajv, type AnySchema } from 'ajv';
import type { ZodIssue } from 'zod';

import type { RuntimeEvent } from '../../../domain/events/events.js';
import type {
  AgentControlOverrides,
  AgentControlThinking,
} from '../../../domain/types.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { resolveAppScopeAppId } from '../app-identity.js';
import { isValidControlId } from '../../../shared/control-id.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import {
  readJson,
  sendApplicationError as sendApplicationErrorResponse,
  sendError,
  sendJson,
} from '../http.js';
import { parseSessionRoute } from '../route-parser.js';
import {
  acceptMessageForControl,
  createSessionInteractionModule,
  ensureSessionForControl,
  type SessionEventSubscription,
} from '../session-interaction-adapter.js';
import {
  listSessionPendingInteractions,
  respondToSessionPermissionInteraction,
  SESSION_INTERACTION_DECISIONS,
  type SessionInteractionDecision,
  type SessionInteractionRespondOutcome,
} from '../session-interaction-approvals.js';
import { nowMs as currentTimeMs } from '../../../shared/time/datetime.js';

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  const notFoundCode =
    error instanceof Error && error.message === 'Webhook not found'
      ? 'WEBHOOK_NOT_FOUND'
      : error instanceof Error && error.message === 'Agent not found'
        ? 'AGENT_NOT_FOUND'
        : 'SESSION_NOT_FOUND';
  return sendApplicationErrorResponse(res, error, { NOT_FOUND: notFoundCode });
}

function formatSessionRequestIssue(issue: ZodIssue): string {
  if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) {
    return `Unsupported session request field "${issue.keys[0]}".`;
  }
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const responseSchemaCompiler = new Ajv({
  addUsedSchema: false,
  strict: false,
});

function responseSchemaCompileFailure(
  schema: Record<string, unknown>,
): string | undefined {
  try {
    const validate = responseSchemaCompiler.compile(schema as AnySchema);
    if ('$async' in validate && validate.$async === true) {
      return 'response_schema async schemas are unsupported';
    }
    return undefined;
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error';
    return `response_schema failed to compile: ${detail}`;
  }
}

const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

function parseSessionThinking(value: unknown): AgentControlThinking | string {
  if (value === 'off' || value === 'on') return { mode: value };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'thinking must be off, on, or an object';
  }
  const record = value as Record<string, unknown>;
  const unsupported = Object.keys(record).find(
    (key) => key !== 'mode' && key !== 'budget_tokens',
  );
  if (unsupported) return `thinking.${unsupported} is not supported`;
  if (record.mode !== 'off' && record.mode !== 'on') {
    return 'thinking.mode must be off or on';
  }
  if (record.mode === 'off' && record.budget_tokens !== undefined) {
    return 'thinking.budget_tokens requires thinking.mode on';
  }
  if (
    record.budget_tokens !== undefined &&
    (typeof record.budget_tokens !== 'number' ||
      !Number.isInteger(record.budget_tokens) ||
      record.budget_tokens <= 0)
  ) {
    return 'thinking.budget_tokens must be a positive integer';
  }
  return record.budget_tokens === undefined
    ? { mode: record.mode }
    : { mode: 'on', budgetTokens: record.budget_tokens as number };
}

function parseSessionAgentControls(
  body: Record<string, unknown>,
): AgentControlOverrides | string {
  const controls: AgentControlOverrides = {};
  if (body.effort !== undefined) {
    if (!SESSION_EFFORTS.includes(body.effort as never)) {
      return `effort must be one of ${SESSION_EFFORTS.join(', ')}`;
    }
    controls.effort = body.effort as AgentControlOverrides['effort'];
  }
  if (body.thinking !== undefined) {
    const thinking = parseSessionThinking(body.thinking);
    if (typeof thinking === 'string') return thinking;
    controls.thinking = thinking;
  }
  if (body.max_output_tokens !== undefined) {
    if (
      typeof body.max_output_tokens !== 'number' ||
      !Number.isInteger(body.max_output_tokens) ||
      body.max_output_tokens <= 0
    ) {
      return 'max_output_tokens must be a positive integer';
    }
    controls.maxOutputTokens = body.max_output_tokens;
  }
  return controls;
}

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
    const parsed = CreateSessionRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        formatSessionRequestIssue(parsed.error.issues[0]),
      );
      return true;
    }
    const body = parsed.data;
    const assertedAppId = body.appId?.trim() ?? '';
    const appId = resolveAppScopeAppId(auth, assertedAppId);
    const conversationId = (body.conversationId ?? '').trim();
    if (!conversationId) {
      sendError(res, 400, 'INVALID_REQUEST', 'conversationId is required');
      return true;
    }
    if (assertedAppId && !isValidControlId(assertedAppId)) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'appId and conversationId must contain only letters, numbers, dot, underscore, or dash',
      );
      return true;
    }
    if (!appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot access this app');
      return true;
    }
    try {
      const result = await ensureSessionForControl(ctx, {
        appId,
        assertedAppId,
        agentId: body.agentId ?? null,
        conversationId,
        title: body.title ?? null,
        responseMode: body.responseMode,
        webhookId: body.webhookId ?? null,
      });
      sendJson(res, 200, {
        sessionId: result.session.sessionId,
        appId: result.session.appId,
        conversationId: result.session.conversationId,
        chatJid: result.session.conversationJid,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const sessionRoute = parseSessionRoute(pathname);
  if (sessionRoute?.action === 'get' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    try {
      const details = await createSessionInteractionModule().getSessionDetails({
        appId: auth.appId,
        sessionId: sessionRoute.sessionId,
      });
      sendJson(res, 200, details);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (sessionRoute?.action === 'messages' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const limit = parseListLimit(url.searchParams.get('limit'));
    try {
      const result = await createSessionInteractionModule().listMessages({
        appId: auth.appId,
        sessionId: sessionRoute.sessionId,
        limit,
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (sessionRoute?.action === 'interactions' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    try {
      const session = await createSessionInteractionModule().requireSession({
        appId: auth.appId,
        sessionId: sessionRoute.sessionId,
      });
      sendJson(res, 200, await listSessionPendingInteractions(session));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (sessionRoute?.action === 'interaction-respond' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'approvals:write',
    ]);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const decision = body.decision;
    if (
      !SESSION_INTERACTION_DECISIONS.includes(
        decision as SessionInteractionDecision,
      )
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        `decision must be one of ${SESSION_INTERACTION_DECISIONS.join(', ')}`,
      );
      return true;
    }
    try {
      const session = await createSessionInteractionModule().requireSession({
        appId: auth.appId,
        sessionId: sessionRoute.sessionId,
      });
      const outcome = await respondToSessionPermissionInteraction({
        session,
        interactionId: sessionRoute.interactionId,
        decision: decision as SessionInteractionDecision,
        decidedBy: `api-key:${auth.kid}`,
      });
      sendSessionInteractionRespondOutcome(res, outcome);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (sessionRoute?.action === 'runs' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const limit = parseListLimit(url.searchParams.get('limit'));
    try {
      const result = await createSessionInteractionModule().listRuns({
        appId: auth.appId,
        sessionId: sessionRoute.sessionId,
        limit,
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (sessionRoute?.action === 'messages' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'sessions:write',
    ]);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    if (
      body.response_schema !== undefined &&
      !isJsonSchemaObject(body.response_schema)
    ) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'response_schema must be a JSON Schema object',
      );
      return true;
    }
    if (body.response_schema !== undefined) {
      const compileFailure = responseSchemaCompileFailure(
        body.response_schema as Record<string, unknown>,
      );
      if (compileFailure) {
        sendError(res, 400, 'INVALID_REQUEST', compileFailure);
        return true;
      }
    }
    const agentControls = parseSessionAgentControls(body);
    if (typeof agentControls === 'string') {
      sendError(res, 400, 'INVALID_REQUEST', agentControls);
      return true;
    }
    try {
      const accepted = await acceptMessageForControl(ctx, {
        appId: auth.appId,
        sessionId: sessionRoute.sessionId,
        message: String(body.message || ''),
        senderId: typeof body.senderId === 'string' ? body.senderId : 'sdk',
        senderName:
          typeof body.senderName === 'string' ? body.senderName : 'SDK',
        threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
        correlationId:
          typeof body.correlationId === 'string' ? body.correlationId : null,
        responseMode: body.responseMode,
        webhookId: typeof body.webhookId === 'string' ? body.webhookId : null,
        responseSchema: body.response_schema as
          | Record<string, unknown>
          | undefined,
        agentControls:
          Object.keys(agentControls).length > 0 ? agentControls : undefined,
      });
      sendJson(res, 202, {
        accepted: true,
        messageId: accepted.messageId,
        acceptedEventId: accepted.acceptedEventId,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (sessionRoute?.action === 'events' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
    const afterEventId = Number(url.searchParams.get('afterEventId') || 0);
    const module = createSessionInteractionModule();
    let events: RuntimeEvent[];
    try {
      events = await module.listEvents({
        appId: auth.appId,
        sessionId: sessionRoute.sessionId,
        afterEventId,
        limit: 100,
      });
    } catch (error) {
      if (sendApplicationError(res, error)) return true;
      throw error;
    }
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
      const initial = events.length > 0 ? events : [];
      let lastEventId = initial[initial.length - 1]?.eventId;
      let closed = req.destroyed || res.destroyed;
      let streamActive = true;
      let subscription: SessionEventSubscription | undefined;
      const cleanup = () => {
        if (closed && !streamActive && !subscription) return;
        closed = true;
        subscription?.close();
        if (streamActive) {
          streamActive = false;
          ctx.state.activeStreams = Math.max(0, ctx.state.activeStreams - 1);
        }
      };
      req.once('close', cleanup);
      res.once('close', cleanup);
      if (closed) {
        cleanup();
        return true;
      }
      try {
        subscription = await module.subscribeEvents({
          appId: auth.appId,
          sessionId: sessionRoute.sessionId,
          afterEventId: lastEventId ?? afterEventId,
          limit: 100,
        });
      } catch (error) {
        cleanup();
        if (sendApplicationError(res, error)) return true;
        throw error;
      }
      if (closed || req.destroyed || res.destroyed) {
        cleanup();
        return true;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
      for (const event of initial) {
        await writeSseEvent(res, event, () => closed);
      }
      const pump = async () => {
        while (!closed) {
          try {
            const next = await subscription.next({ timeoutMs: 30_000 });
            for (const event of next) {
              lastEventId = event.eventId;
              await writeSseEvent(res, event, () => closed);
            }
          } catch (error) {
            if (closed) return;
            logger.warn(
              { err: error, sessionId: sessionRoute.sessionId },
              'Failed streaming runtime events',
            );
            await delay(1000);
          }
        }
      };
      void pump();
      return true;
    }
    sendJson(res, 200, {
      events: events.map(serializeSessionEventEnvelope),
    });
    return true;
  }

  if (sessionRoute?.action === 'wait' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['sessions:read']);
    if (!auth) return true;
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
    const startedAt = currentTimeMs();
    try {
      const visible =
        await createSessionInteractionModule().waitForVisibleEvent({
          appId: auth.appId,
          sessionId: sessionRoute.sessionId,
          afterEventId,
          timeoutMs: Math.max(0, timeoutMs - (currentTimeMs() - startedAt)),
        });
      sendJson(res, 200, {
        ...serializeSessionEventEnvelope(visible),
        afterEventId: visible.eventId,
      });
      return true;
    } catch (error) {
      if (sendApplicationError(res, error)) return true;
      throw error;
    } finally {
      ctx.state.activeWaits = Math.max(0, ctx.state.activeWaits - 1);
    }
  }

  return false;
}

function sendSessionInteractionRespondOutcome(
  res: ServerResponse,
  outcome: SessionInteractionRespondOutcome,
): void {
  switch (outcome.status) {
    case 'resolved':
      sendJson(res, 200, outcome);
      return;
    case 'not_found':
      sendError(
        res,
        404,
        'INTERACTION_NOT_FOUND',
        'No pending interaction with this id exists for this session.',
      );
      return;
    case 'already_resolved':
      sendError(
        res,
        409,
        'INTERACTION_ALREADY_RESOLVED',
        'This interaction was already decided.',
      );
      return;
    case 'question_unsupported':
      sendError(
        res,
        409,
        'INTERACTION_KIND_UNSUPPORTED',
        'Question interactions cannot be answered through this API yet; only permission interactions are supported.',
      );
      return;
    case 'batch_unsupported':
      sendError(
        res,
        409,
        'INTERACTION_BATCH_UNSUPPORTED',
        'This interaction is part of a batched channel prompt; decide it from the channel that rendered it.',
      );
      return;
    case 'option_unavailable':
      sendError(
        res,
        409,
        'DECISION_UNAVAILABLE',
        `This decision is not available for this interaction. Available: ${outcome.options.join(', ') || 'none'}.`,
      );
      return;
    case 'malformed':
      sendError(
        res,
        409,
        'INTERACTION_MALFORMED',
        'The pending interaction record is missing its permission request snapshot.',
      );
      return;
    default:
      sendError(
        res,
        503,
        'INTERACTION_RETRYABLE',
        'Could not record the decision. Please retry.',
      );
  }
}

async function writeSseEvent(
  res: ServerResponse,
  event: RuntimeEvent,
  isClosed: () => boolean = () => false,
): Promise<void> {
  if (isClosed() || res.destroyed) return;
  const chunk = [
    `id: ${event.eventId}`,
    `event: ${sanitizeSseEventType(event.eventType)}`,
    `data: ${JSON.stringify(serializeSessionEventEnvelope(event))}`,
    '',
    '',
  ].join('\n');
  if (res.write(chunk)) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res.off('drain', finish);
      res.off('close', finish);
      res.off('error', finish);
      resolve();
    };
    res.once('drain', finish);
    res.once('close', finish);
    res.once('error', finish);
    if (isClosed() || res.destroyed) finish();
  });
}

function sanitizeSseEventType(eventType: string): string {
  return /^[a-z0-9._-]+$/.test(eventType) ? eventType : 'runtime_event';
}

function serializeSessionEventEnvelope(event: RuntimeEvent): {
  eventId: RuntimeEvent['eventId'];
  eventType: RuntimeEvent['eventType'];
  sessionId: RuntimeEvent['sessionId'] | null;
  threadId: RuntimeEvent['threadId'] | null;
  correlationId: RuntimeEvent['correlationId'] | null;
  createdAt: RuntimeEvent['createdAt'];
  payload: RuntimeEvent['payload'];
} {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    sessionId: event.sessionId ?? null,
    threadId: event.threadId ?? null,
    correlationId: event.correlationId ?? null,
    createdAt: event.createdAt,
    payload: event.payload,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseListLimit(raw: string | null): number {
  if (raw === null || raw === '') return 100;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(200, Math.max(1, Math.floor(parsed)));
}

export const _testSessionRoutes = {
  writeSseEvent,
};
