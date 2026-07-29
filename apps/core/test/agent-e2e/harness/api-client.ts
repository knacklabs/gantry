// Minimal typed Control API client for agent E2E runs. Plain fetch on purpose:
// the hand SDK (packages/sdk) needs a build step and lacks agent/skill admin
// wrappers (agent-e2e-plan-validation-round3.md §2), so the harness talks to
// the same public HTTP surface any client would.

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export interface SessionEnsureResult {
  sessionId: string;
  appId: string;
  conversationId: string;
  chatJid: string;
}

export interface AcceptedMessage {
  accepted: boolean;
  messageId: string;
  acceptedEventId: number;
}

export interface SessionEvent {
  eventId: number;
  eventType: string;
  sessionId: string | null;
  threadId: string | null;
  correlationId: string | null;
  createdAt: string;
  payload: unknown;
}

/** Raw runtime event types that end a run (run-event-projection.ts). */
export const TERMINAL_RUN_EVENT_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.timeout',
  'run.dead_lettered',
  'run.canceled',
]);

export class AgentE2EApiClient {
  constructor(
    readonly baseUrl: string,
    readonly apiKey: string,
  ) {}

  /** Generic escape hatch: any Control API request with bearer auth. */
  async request<T = unknown>(
    method: string,
    requestPath: string,
    options: {
      body?: unknown;
      /** Raw body (e.g. skill zip). Wins over `body`. */
      rawBody?: Uint8Array;
      contentType?: string;
    } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    let body: string | Uint8Array | undefined;
    if (options.rawBody !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/zip';
      body = options.rawBody;
    } else if (options.body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json';
      body = JSON.stringify(options.body);
    }
    const res = await fetch(`${this.baseUrl}${requestPath}`, {
      method,
      headers,
      body,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body (kept raw for the caller's assertion/message).
    }
    return { status: res.status, body: parsed as T };
  }

  private async expect<T>(
    expectedStatus: number,
    method: string,
    requestPath: string,
    options?: Parameters<AgentE2EApiClient['request']>[2],
  ): Promise<T> {
    const res = await this.request<T>(method, requestPath, options);
    if (res.status !== expectedStatus) {
      throw new Error(
        `${method} ${requestPath} returned ${res.status} (expected ${expectedStatus}): ${JSON.stringify(res.body).slice(0, 500)}`,
      );
    }
    return res.body;
  }

  async ensureSession(input: {
    conversationId: string;
    appId?: string;
    title?: string;
  }): Promise<SessionEnsureResult> {
    return await this.expect<SessionEnsureResult>(
      200,
      'POST',
      '/v1/sessions/ensure',
      { body: input },
    );
  }

  /** 202 = accepted, NOT completed — pair with waitForTerminalRunEvent. */
  async postMessage(
    sessionId: string,
    message: string,
    extra: Record<string, unknown> = {},
  ): Promise<AcceptedMessage> {
    return await this.expect<AcceptedMessage>(
      202,
      'POST',
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { body: { message, ...extra } },
    );
  }

  async listEvents(
    sessionId: string,
    afterEventId = 0,
  ): Promise<SessionEvent[]> {
    const body = await this.expect<{ events: SessionEvent[] }>(
      200,
      'GET',
      `/v1/sessions/${encodeURIComponent(sessionId)}/events?afterEventId=${afterEventId}`,
    );
    return body.events;
  }

  /**
   * Poll events until a terminal run event appears (a 202 on the message POST
   * is accepted-not-done). Returns every event observed plus the terminal one.
   */
  async waitForTerminalRunEvent(
    sessionId: string,
    options: { afterEventId?: number; timeoutMs?: number } = {},
  ): Promise<{ terminal: SessionEvent; events: SessionEvent[] }> {
    const { match, events } = await this.waitForSessionEvent(
      sessionId,
      (event) => TERMINAL_RUN_EVENT_TYPES.has(event.eventType),
      { ...options, description: 'terminal run event' },
    );
    return { terminal: match, events };
  }

  /**
   * Poll until a durable assistant reply exists for the session. The app
   * channel is event-sourced: replies arrive as session.message.outbound
   * events or as session.message.streaming events whose terminal chunk has
   * done=true — both persisted runtime_events rows (the delivery record for
   * API sessions). Live sessions keep the run open after replying, so
   * run.completed is NOT the completion signal; a run FAILURE event before
   * the reply is fatal.
   */
  async waitForDurableAssistantReply(
    sessionId: string,
    options: { timeoutMs?: number } = {},
  ): Promise<{ reply: Record<string, unknown>; events: SessionEvent[] }> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    const events: SessionEvent[] = [];
    let cursor = 0;
    // The terminal streaming chunk carries only the sanitizer's REMAINING
    // delta (usually empty when everything already streamed), so the reply
    // text must be accumulated across the done=false chunks.
    let streamedText = '';
    while (Date.now() < deadline) {
      const page = await this.listEvents(sessionId, cursor);
      for (const event of page) {
        events.push(event);
        cursor = Math.max(cursor, event.eventId);
        if (
          TERMINAL_RUN_EVENT_TYPES.has(event.eventType) &&
          event.eventType !== 'run.completed'
        ) {
          throw new Error(
            `run ended ${event.eventType} before a durable reply ` +
              `(payload: ${JSON.stringify(event.payload).slice(0, 300)})`,
          );
        }
        const payload = (event.payload ?? {}) as {
          text?: unknown;
          done?: unknown;
        };
        const hasText =
          typeof payload.text === 'string' && payload.text.trim().length > 0;
        if (event.eventType === 'session.message.outbound' && hasText) {
          return { reply: payload as Record<string, unknown>, events };
        }
        if (event.eventType === 'session.message.streaming') {
          if (hasText) streamedText += payload.text as string;
          if (payload.done === true && streamedText.trim().length > 0) {
            return { reply: { text: streamedText, done: true }, events };
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `No durable assistant reply for session ${sessionId} ` +
        `within ${timeoutMs}ms ` +
        `(events: ${events.map((event) => event.eventType).join(', ') || 'none'})`,
    );
  }

  /**
   * Poll events until `predicate` matches (a 202 on the message POST is
   * accepted-not-done). Returns every event observed plus the match.
   */
  async waitForSessionEvent(
    sessionId: string,
    predicate: (event: SessionEvent) => boolean,
    options: {
      afterEventId?: number;
      timeoutMs?: number;
      description?: string;
    } = {},
  ): Promise<{ match: SessionEvent; events: SessionEvent[] }> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    const events: SessionEvent[] = [];
    let cursor = options.afterEventId ?? 0;
    while (Date.now() < deadline) {
      const page = await this.listEvents(sessionId, cursor);
      for (const event of page) {
        events.push(event);
        cursor = Math.max(cursor, event.eventId);
        if (predicate(event)) {
          return { match: event, events };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(
      `No ${options.description ?? 'matching'} event for session ` +
        `${sessionId} within ${timeoutMs}ms ` +
        `(saw: ${events.map((event) => event.eventType).join(', ') || 'none'})`,
    );
  }

  /** POST /v1/skills/install (application/zip). Returns the created skill. */
  async installSkillZip(
    zip: Uint8Array,
    options: { agentId?: string } = {},
  ): Promise<unknown> {
    const query = options.agentId
      ? `?agentId=${encodeURIComponent(options.agentId)}`
      : '';
    return await this.expect(201, 'POST', `/v1/skills/install${query}`, {
      rawBody: zip,
    });
  }
}
