import type { AgentRun } from '../../domain/events/events.js';
import type { Message, MessagePart } from '../../domain/messages/messages.js';
import type {
  AgentRunRepository,
  AgentSessionRepository,
  AgentSessionSummaryRepository,
  MessageRepository,
} from '../../domain/ports/repositories.js';
import type {
  AgentSessionId,
  AgentSessionSummary,
  AgentSessionSummaryId,
} from '../../domain/sessions/sessions.js';

export interface SessionSummaryCheckpointOptions {
  summaryAfterMessages: number;
  summaryAfterRuns: number;
}

export class SessionSummaryCheckpointService {
  constructor(
    private readonly sessions: AgentSessionRepository,
    private readonly messages: MessageRepository,
    private readonly runs: AgentRunRepository,
    private readonly summaries: AgentSessionSummaryRepository,
    private readonly options: SessionSummaryCheckpointOptions,
  ) {}

  async checkpoint(input: { sessionId: AgentSessionId; now?: string }) {
    const session = await this.sessions.getAgentSession(input.sessionId);
    if (!session?.conversationId) return { created: false, summary: null };
    const latest = await this.summaries.getLatestAgentSessionSummary(
      session.id,
    );
    const messages = await this.messages.listMessages({
      conversationId: session.conversationId,
      threadId: session.threadId,
      after: latest?.toMessageId,
      limit: this.options.summaryAfterMessages,
    });
    const recentRuns = await this.runs.listAgentRunsBySession({
      sessionId: session.id,
      limit: this.options.summaryAfterRuns,
    });
    const previousRunIndex = latest?.toRunId
      ? recentRuns.findIndex((run) => run.id === latest.toRunId)
      : -1;
    const runs =
      previousRunIndex >= 0
        ? recentRuns.slice(0, previousRunIndex)
        : recentRuns;
    if (
      messages.length < this.options.summaryAfterMessages &&
      runs.length < this.options.summaryAfterRuns
    ) {
      return { created: false, summary: latest };
    }
    const summaryText = buildExtractiveSummary(messages, runs);
    if (!summaryText.trim()) return { created: false, summary: latest };
    const createdAt = input.now ?? new Date().toISOString();
    const summary: AgentSessionSummary = {
      id: summaryId({
        sessionId: session.id,
        toMessageId: messages[messages.length - 1]?.id,
        toRunId: runs[0]?.id,
        createdAt,
      }),
      appId: session.appId,
      agentSessionId: session.id,
      summary: summaryText,
      source: 'extractive',
      fromMessageId: messages[0]?.id,
      toMessageId: messages[messages.length - 1]?.id,
      fromRunId: runs[runs.length - 1]?.id,
      toRunId: runs[0]?.id,
      messageCount: messages.length,
      runCount: runs.length,
      createdAt,
    };
    await this.summaries.saveAgentSessionSummary(summary);
    return { created: true, summary };
  }
}

function summaryId(input: {
  sessionId: AgentSessionId;
  toMessageId?: string;
  toRunId?: string;
  createdAt: string;
}): AgentSessionSummaryId {
  const key = [
    input.sessionId,
    input.toMessageId ?? '',
    input.toRunId ?? '',
    input.createdAt,
  ].join(':');
  return `agent-session-summary:${encodeURIComponent(key)}` as AgentSessionSummaryId;
}

function messagePartText(part: MessagePart): string {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'markdown':
      return part.markdown;
    case 'code':
      return part.code;
    case 'structured':
    case 'tool_result':
      return JSON.stringify(part.value);
    case 'redacted':
      return `[redacted: ${part.reason}]`;
  }
}

function messageLine(message: Message): string {
  const text = message.parts.map(messagePartText).join(' ').trim();
  const clipped = text.length > 220 ? `${text.slice(0, 217)}...` : text;
  return `- ${message.createdAt} ${message.direction}: ${clipped}`;
}

function runLine(run: AgentRun): string | null {
  const summary = run.resultSummary || run.errorSummary;
  if (!summary) return null;
  return `- ${run.createdAt} ${run.status}: ${summary}`;
}

function buildExtractiveSummary(messages: Message[], runs: AgentRun[]): string {
  const messageLines = messages.map(messageLine).filter(Boolean);
  const runLines = runs.flatMap((run) => {
    const line = runLine(run);
    return line ? [line] : [];
  });
  return [
    '## Summary',
    'Extractive checkpoint from durable MyClaw DB state.',
    '',
    '## Messages',
    messageLines.length > 0 ? messageLines.join('\n') : '- none',
    '',
    '## Runs',
    runLines.length > 0 ? runLines.join('\n') : '- none',
  ].join('\n');
}
