import {
  RICH_INTERACTION_NATIVE_FALLBACK_TEXT,
  type RichInteractionRequest,
  type UserQuestionRequest,
  type UserQuestionResponse,
} from '../../domain/types.js';
import type {
  AgentTodoCardStatus,
  AgentTodoRender,
} from '../../domain/ports/task-lifecycle.js';
import { DurableInteractionPersistenceError } from '../../application/interactions/pending-interaction-durability.js';

type ChannelLike = object;

interface ChannelWiringInteractionsLogger {
  debug: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
  error: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
}

interface UserQuestionSurfaceLike {
  requestUserAnswer: (
    targetJid: string,
    request: UserQuestionRequest,
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void,
  ) => Promise<UserQuestionResponse>;
  questionIndexesForDeliveredPrompt?: (
    request: UserQuestionRequest,
    firstQuestionIndex: number,
  ) => number[];
  dropPendingInteraction?: (
    kind: 'permission' | 'question',
    request: UserQuestionRequest,
  ) => void;
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

type ProviderAccountOptions = { providerAccountId?: string };

export interface AgentTodoRenderer {
  (
    jid: string,
    render: AgentTodoRender,
    options?: ProviderAccountOptions,
  ): Promise<boolean>;
  finalize: (
    jid: string,
    input: {
      threadId?: string | null;
      cardKind?: AgentTodoRender['cardKind'];
      status: AgentTodoCardStatus;
    },
    options?: ProviderAccountOptions,
  ) => Promise<boolean>;
}

export function createUserQuestionResponder(input: {
  findBoundChannel: (
    jid: string,
    request?: UserQuestionRequest,
  ) => ChannelLike | undefined;
  asUserQuestionSurface: (
    channel: ChannelLike,
  ) => UserQuestionSurfaceLike | undefined;
  interactionLifecycle: {
    logger: ChannelWiringInteractionsLogger;
    resetStreaming?: (
      jid: string,
      options?: { providerAccountId?: string; threadId?: string },
    ) => void;
  };
}): {
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  clear: () => void;
} {
  const userQuestionResponseCache = new Map<string, UserQuestionResponse>();

  async function dispatchUserAnswer(
    request: UserQuestionRequest,
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void,
  ): Promise<UserQuestionResponse> {
    if (!request.targetJid) {
      return { requestId: request.requestId, answers: {} };
    }

    const channel = input.findBoundChannel(request.targetJid, request);
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
        (messageId, questionIndex) => {
          input.interactionLifecycle.resetStreaming?.(request.targetJid!, {
            providerAccountId: request.providerAccountId,
            threadId: request.threadId,
          });
          if (questionIndex === undefined) {
            onPromptDelivered?.(messageId);
            return;
          }
          const deliveredIndexes =
            questionSurface.questionIndexesForDeliveredPrompt?.(
              request,
              questionIndex,
            ) ?? [questionIndex];
          deliveredIndexes.forEach((index) =>
            onPromptDelivered?.(messageId, index),
          );
        },
      );
      return response;
    } catch (err) {
      if (err instanceof DurableInteractionPersistenceError) {
        questionSurface.dropPendingInteraction?.('question', request);
        throw err;
      }
      input.interactionLifecycle.logger.error({
        err,
        targetJid: request.targetJid,
        requestId: request.requestId,
        message: 'Target channel user question flow failed',
      });
      return { requestId: request.requestId, answers: {} };
    }
  }

  async function requestUserAnswer(
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    const requestKey = `${request.targetJid}:${request.requestId}`;
    const cached = userQuestionResponseCache.get(requestKey);
    if (cached) return cached;
    const response = await dispatchUserAnswer(request);
    userQuestionResponseCache.set(requestKey, response);
    return response;
  }

  return {
    requestUserAnswer,
    clear: () => {
      userQuestionResponseCache.clear();
    },
  };
}

export function createRichInteractionRenderer(input: {
  findBoundChannel: (
    jid: string,
    providerAccountId?: string,
  ) => ChannelLike | undefined;
  asRichInteractionSurface: (
    channel: ChannelLike,
  ) => RichInteractionSurfaceLike | undefined;
  sendMessage: (
    jid: string,
    text: string,
    options?: { threadId?: string; providerAccountId?: string },
  ) => Promise<unknown>;
  logger: Pick<ChannelWiringInteractionsLogger, 'error'>;
}): (
  jid: string,
  request: RichInteractionRequest,
  options?: ProviderAccountOptions,
) => Promise<boolean> {
  return async (jid, request, options): Promise<boolean> => {
    const providerAccountId =
      options?.providerAccountId ?? request.providerAccountId;
    const channel = input.findBoundChannel(jid, providerAccountId);
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
      {
        ...(request.threadId ? { threadId: request.threadId } : {}),
        ...(providerAccountId ? { providerAccountId } : {}),
      },
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
  findBoundChannel: (
    jid: string,
    providerAccountId?: string,
  ) => ChannelLike | undefined;
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

  const getSurface = (
    jid: string,
    options?: ProviderAccountOptions,
  ): AgentTodoSurfaceLike | undefined => {
    const channel = input.findBoundChannel(jid, options?.providerAccountId);
    return channel ? input.asAgentTodoSurface(channel) : undefined;
  };

  const flush = async (
    jid: string,
    render: AgentTodoRender,
    options?: ProviderAccountOptions,
  ): Promise<boolean> => {
    const surface = getSurface(jid, options);
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

  const renderKey = (
    jid: string,
    render: AgentTodoRender,
    options?: ProviderAccountOptions,
  ): string =>
    `${options?.providerAccountId ?? ''}:${jid}:${render.threadId ?? ''}:${render.cardKind ?? 'todo'}`;

  const openWindow = (
    key: string,
    jid: string,
    options?: ProviderAccountOptions,
  ): void => {
    const timer = setTimeout(() => {
      const entry = windows.get(key);
      if (!entry) return;
      const next = entry.pending;
      if (next) {
        entry.pending = null;
        openWindow(key, jid, options);
        void flush(jid, next, options);
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
    options?: ProviderAccountOptions,
  ): Promise<boolean> => {
    if (!jid || !getSurface(jid, options)) return false;
    const key = renderKey(jid, render, options);
    latest.set(key, render);
    if (render.flush) {
      const existing = windows.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        windows.delete(key);
      }
      return flush(jid, render, options);
    }
    const existing = windows.get(key);
    if (existing) {
      // Within the throttle window: keep only the latest plan; it flushes on close.
      existing.pending = render;
      return true;
    }
    openWindow(key, jid, options);
    return flush(jid, render, options);
  }) as AgentTodoRenderer;

  renderTodo.finalize = async (
    jid: string,
    final: {
      threadId?: string | null;
      cardKind?: AgentTodoRender['cardKind'];
      status: AgentTodoCardStatus;
    },
    options?: ProviderAccountOptions,
  ): Promise<boolean> => {
    if (!jid || !getSurface(jid, options)) return false;
    const key = renderKey(
      jid,
      {
        summary: null,
        items: [],
        threadId: final.threadId ?? null,
        cardKind: final.cardKind ?? 'todo',
      },
      options,
    );
    const render = latest.get(key);
    if (!render) return false;
    return renderTodo(
      jid,
      {
        ...render,
        status: final.status,
        stop: undefined,
        updatedAt: new Date().toISOString(),
        flush: true,
      },
      options,
    );
  };

  return renderTodo;
}
