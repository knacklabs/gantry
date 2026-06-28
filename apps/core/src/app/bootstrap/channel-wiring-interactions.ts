import {
  RICH_INTERACTION_NATIVE_FALLBACK_TEXT,
  type PermissionApprovalDecision,
  type PermissionApprovalRequest,
  type RichInteractionRequest,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from '../../domain/types.js';
import type {
  AgentTodoCardStatus,
  AgentTodoRender,
} from '../../domain/ports/task-lifecycle.js';
import { formatDuration } from '../../shared/human-format.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../shared/permission-timeout.js';

type ChannelLike = object;

interface ChannelWiringInteractionsLogger {
  debug: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
  error: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
}

interface PermissionApprovalSurfaceLike {
  requestPermissionApproval: (
    targetJid: string,
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
}

interface UserQuestionSurfaceLike {
  requestUserAnswer: (
    targetJid: string,
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
}

interface AgentTodoSurfaceLike {
  renderAgentTodo: (
    jid: string,
    render: AgentTodoRender,
  ) => Promise<void | boolean>;
}

interface RichInteractionSurfaceLike {
  renderRichInteraction: (
    jid: string,
    request: RichInteractionRequest,
  ) => Promise<void | boolean>;
}

export interface AgentTodoRenderer {
  (jid: string, render: AgentTodoRender): Promise<boolean>;
  finalize: (
    jid: string,
    input: {
      threadId?: string | null;
      cardKind?: AgentTodoRender['cardKind'];
      status: AgentTodoCardStatus;
    },
  ) => Promise<boolean>;
}

interface PermissionApprovalTargetResolution {
  targetJid: string;
  request: PermissionApprovalRequest;
}

interface PermissionApprovalTargetBlocked {
  blockedReason: string;
}

const permissionTimeoutDecision = (
  _request: PermissionApprovalRequest,
): PermissionApprovalDecision => ({
  approved: false,
  decidedBy: 'system',
  reason: `No approval received within ${formatDuration(PERMISSION_APPROVAL_TIMEOUT_MS)}. Retry when an approver is available.`,
  decisionClassification: 'user_reject',
});

function resolvePermissionApprovalTarget(
  request: PermissionApprovalRequest,
): PermissionApprovalTargetResolution | PermissionApprovalTargetBlocked {
  const targetJid = request.targetJid;
  if (!targetJid) {
    return { blockedReason: 'Permission approval target is missing' };
  }
  return { targetJid, request };
}

export function createPermissionApprovalRequester(input: {
  findBoundChannel: (jid: string) => ChannelLike | undefined;
  asPermissionApprovalSurface: (
    channel: ChannelLike,
  ) => PermissionApprovalSurfaceLike | undefined;
  logger: Pick<ChannelWiringInteractionsLogger, 'error'>;
}): (
  request: PermissionApprovalRequest,
) => Promise<PermissionApprovalDecision> {
  return async (
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> => {
    if (!request.targetJid) {
      return {
        approved: false,
        reason: 'Permission approval target is missing',
      };
    }

    const routed = resolvePermissionApprovalTarget(request);
    if ('blockedReason' in routed) {
      return { approved: false, reason: routed.blockedReason };
    }
    const channel = input.findBoundChannel(routed.targetJid);
    const approvalSurface = channel
      ? input.asPermissionApprovalSurface(channel)
      : undefined;
    if (!approvalSurface) {
      return {
        approved: false,
        reason: 'Target channel does not support permission approvals',
      };
    }
    try {
      return await new Promise<PermissionApprovalDecision>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(permissionTimeoutDecision(request));
        }, PERMISSION_APPROVAL_TIMEOUT_MS);
        approvalSurface
          .requestPermissionApproval(routed.targetJid, routed.request)
          .then((decision) => {
            if (settled) {
              input.logger.error({
                targetJid: routed.targetJid,
                requestId: request.requestId,
                message: 'Late permission approval ignored after timeout',
              });
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(decision);
          })
          .catch((err: unknown) => {
            if (settled) {
              input.logger.error({
                err,
                targetJid: routed.targetJid,
                requestId: request.requestId,
                message:
                  'Late permission approval failure ignored after timeout',
              });
              return;
            }
            settled = true;
            clearTimeout(timer);
            input.logger.error({
              err,
              targetJid: routed.targetJid,
              requestId: request.requestId,
              message: 'Target channel permission approval flow failed',
            });
            resolve({
              approved: false,
              reason: 'Permission approval flow failed',
            });
          });
      });
    } catch (err) {
      input.logger.error({
        err,
        targetJid: routed.targetJid,
        requestId: request.requestId,
        message: 'Target channel permission approval flow failed',
      });
      return { approved: false, reason: 'Permission approval flow failed' };
    }
  };
}

export function createUserQuestionResponder(input: {
  findBoundChannel: (jid: string) => ChannelLike | undefined;
  asUserQuestionSurface: (
    channel: ChannelLike,
  ) => UserQuestionSurfaceLike | undefined;
  logger: ChannelWiringInteractionsLogger;
}): {
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  clear: () => void;
} {
  const userQuestionResponseCache = new Map<string, UserQuestionResponse>();

  async function requestUserAnswer(
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    if (!request.targetJid) {
      return { requestId: request.requestId, answers: {} };
    }

    const requestKey = `${request.targetJid}:${request.requestId}`;
    const cached = userQuestionResponseCache.get(requestKey);
    if (cached) return cached;
    const channel = input.findBoundChannel(request.targetJid);
    const questionSurface = channel
      ? input.asUserQuestionSurface(channel)
      : undefined;
    if (!channel || !questionSurface) {
      return { requestId: request.requestId, answers: {} };
    }
    try {
      const response = await questionSurface.requestUserAnswer(
        request.targetJid,
        request,
      );
      userQuestionResponseCache.set(requestKey, response);
      return response;
    } catch (err) {
      input.logger.error({
        err,
        targetJid: request.targetJid,
        requestId: request.requestId,
        message: 'Target channel user question flow failed',
      });
      return { requestId: request.requestId, answers: {} };
    }
  }

  return {
    requestUserAnswer,
    clear: () => {
      userQuestionResponseCache.clear();
    },
  };
}

export function createRichInteractionRenderer(input: {
  findBoundChannel: (jid: string) => ChannelLike | undefined;
  asRichInteractionSurface: (
    channel: ChannelLike,
  ) => RichInteractionSurfaceLike | undefined;
  sendMessage: (
    jid: string,
    text: string,
    options?: { threadId?: string },
  ) => Promise<unknown>;
  logger: Pick<ChannelWiringInteractionsLogger, 'error'>;
}): (jid: string, request: RichInteractionRequest) => Promise<boolean> {
  return async (jid, request): Promise<boolean> => {
    const channel = input.findBoundChannel(jid);
    const surface = channel
      ? input.asRichInteractionSurface(channel)
      : undefined;
    if (surface) {
      try {
        if ((await surface.renderRichInteraction(jid, request)) !== false) {
          return true;
        }
      } catch (err) {
        input.logger.error({
          err,
          jid,
          requestId: request.requestId,
          message: 'Target channel rich interaction render failed',
        });
      }
    }
    await input.sendMessage(
      jid,
      `${RICH_INTERACTION_NATIVE_FALLBACK_TEXT}\n\n${request.descriptor.rich?.fallbackText ?? request.descriptor.fallbackText ?? ''}`.trim(),
      { ...(request.threadId ? { threadId: request.threadId } : {}) },
    );
    return true;
  };
}

// Renders an agent todo/plan to the bound channel, live-updating in place.
// Best-effort: a missing channel or a render failure is logged and swallowed so
// it never breaks the originating todo_update tool response. Per-conversation
// throttle: the first update renders immediately (leading edge); rapid follow-ups
// within the window are coalesced and only the latest flushes once the window
// closes (trailing edge). This keeps the plan visible promptly while avoiding
// edit flicker and provider rate limits when an agent updates the plan in a burst.
// Message-id state is in-memory by design: an interrupted run loses its pending
// question regardless, and a restarted todo simply posts one fresh message, so
// durable cross-restart persistence is intentionally not modeled here.
const AGENT_TODO_RENDER_THROTTLE_MS = 1000;

export function createAgentTodoRenderer(input: {
  findBoundChannel: (jid: string) => ChannelLike | undefined;
  asAgentTodoSurface: (
    channel: ChannelLike,
  ) => AgentTodoSurfaceLike | undefined;
  logger: Pick<ChannelWiringInteractionsLogger, 'error'>;
}): AgentTodoRenderer {
  const windows = new Map<
    string,
    { pending: AgentTodoRender | null; timer: ReturnType<typeof setTimeout> }
  >();
  // ponytail: ceiling is the latest in-memory render only; todo state stays non-durable.
  const latest = new Map<string, AgentTodoRender>();

  const getSurface = (jid: string): AgentTodoSurfaceLike | undefined => {
    const channel = input.findBoundChannel(jid);
    return channel ? input.asAgentTodoSurface(channel) : undefined;
  };

  const flush = async (
    jid: string,
    render: AgentTodoRender,
  ): Promise<boolean> => {
    const surface = getSurface(jid);
    if (!surface) return false;
    try {
      return (await surface.renderAgentTodo(jid, render)) !== false;
    } catch (err) {
      input.logger.error({
        err,
        jid,
        message: 'Target channel agent todo render failed',
      });
      return false;
    }
  };

  const renderKey = (jid: string, render: AgentTodoRender): string =>
    `${jid}:${render.threadId ?? ''}:${render.cardKind ?? 'todo'}`;

  const openWindow = (key: string, jid: string): void => {
    const timer = setTimeout(() => {
      const entry = windows.get(key);
      if (!entry) return;
      const next = entry.pending;
      if (next) {
        entry.pending = null;
        openWindow(key, jid);
        void flush(jid, next);
      } else {
        windows.delete(key);
      }
    }, AGENT_TODO_RENDER_THROTTLE_MS);
    // Don't let a pending plan flush keep the process alive on shutdown.
    (timer as { unref?: () => void }).unref?.();
    windows.set(key, { pending: windows.get(key)?.pending ?? null, timer });
  };

  const renderTodo = (async (
    jid: string,
    render: AgentTodoRender,
  ): Promise<boolean> => {
    if (!jid || !getSurface(jid)) return false;
    const key = renderKey(jid, render);
    latest.set(key, render);
    if (render.flush) {
      const existing = windows.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        windows.delete(key);
      }
      return flush(jid, render);
    }
    const existing = windows.get(key);
    if (existing) {
      // Within the throttle window: keep only the latest plan; it flushes on close.
      existing.pending = render;
      return true;
    }
    openWindow(key, jid);
    return flush(jid, render);
  }) as AgentTodoRenderer;

  renderTodo.finalize = async (
    jid: string,
    final: {
      threadId?: string | null;
      cardKind?: AgentTodoRender['cardKind'];
      status: AgentTodoCardStatus;
    },
  ): Promise<boolean> => {
    if (!jid || !getSurface(jid)) return false;
    const key = renderKey(jid, {
      summary: null,
      items: [],
      threadId: final.threadId ?? null,
      cardKind: final.cardKind ?? 'todo',
    });
    const render = latest.get(key);
    if (!render) return false;
    return renderTodo(jid, {
      ...render,
      status: final.status,
      stop: undefined,
      updatedAt: new Date().toISOString(),
      flush: true,
    });
  };

  return renderTodo;
}
