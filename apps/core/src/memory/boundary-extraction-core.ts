import type { Message, MessagePart } from '../domain/messages/messages.js';
import type { MemoryItem, MemorySubject } from '../domain/memory/memory.js';
import type { AgentSession } from '../domain/sessions/sessions.js';
import type {
  MemoryBoundaryTurn,
  MemoryBoundaryDefaultScope,
  SessionMemoryCollector,
} from '../domain/ports/session-memory-collector.js';
import type {
  ArcExtractionInput,
  ExtractedMemoryFact,
} from './extractor-types.js';

interface BoundaryMemoryRepositories {
  agentSessions: {
    getAgentSession: (
      id: AgentSession['id'],
    ) => Promise<AgentSession | null | undefined>;
  };
  messages: {
    listRecentMessages: (input: {
      conversationId: NonNullable<AgentSession['conversationId']>;
      threadId: AgentSession['threadId'];
      limit: number;
    }) => Promise<Message[]>;
  };
  memory: {
    listMemoryItems: (
      subject: MemorySubject,
      limit: number,
    ) => Promise<MemoryItem[]>;
    saveMemoryItem: (item: MemoryItem) => Promise<unknown>;
  };
}

export async function collectDurableMemoryFromRepositories(input: {
  agentSessionId: string;
  trigger: Parameters<SessionMemoryCollector>[0]['trigger'];
  repositories: BoundaryMemoryRepositories;
  extractFacts: (
    input: ArcExtractionInput,
  ) => Promise<ExtractedMemoryFact[]> | ExtractedMemoryFact[];
  defaultScope?: MemoryBoundaryDefaultScope;
  additionalTurns?: MemoryBoundaryTurn[];
}): Promise<{ saved: number }> {
  const session = await input.repositories.agentSessions.getAgentSession(
    input.agentSessionId as AgentSession['id'],
  );
  if (!session?.conversationId) return { saved: 0 };

  const messages = await input.repositories.messages.listRecentMessages({
    conversationId: session.conversationId,
    threadId: session.threadId,
    limit: 80,
  });
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const message of messages) {
    const text = messageText(message);
    if (!text) continue;
    if (message.direction === 'inbound') {
      turns.push({ role: 'user', text });
    } else if (message.direction === 'outbound') {
      turns.push({ role: 'assistant', text });
    }
  }
  for (const turn of input.additionalTurns ?? []) {
    const text = turn.text.trim();
    if (!text) continue;
    turns.push({ role: turn.role, text });
  }
  if (turns.length === 0) return { saved: 0 };

  const retrievedItems = (
    await Promise.all(
      memorySubjectsForSession(session).map((subject) =>
        input.repositories.memory.listMemoryItems(subject, 10),
      ),
    )
  )
    .flat()
    .filter((item) => !item.isDeleted)
    .map((item) => ({ id: item.id, key: item.key, value: item.value }));

  const facts = await input.extractFacts({
    turns,
    trigger: input.trigger,
    userId: session.userId,
    retrievedItems,
  });
  const now = new Date().toISOString();
  let saved = 0;
  for (const fact of facts) {
    const subject = subjectForFact(fact, session, input.defaultScope);
    await input.repositories.memory.saveMemoryItem({
      id: memoryIdFor({
        appId: session.appId,
        agentId: session.agentId,
        subject,
        kind: fact.kind,
        key: fact.key,
      }) as MemoryItem['id'],
      appId: session.appId,
      agentId: session.agentId,
      subject,
      kind: fact.kind,
      key: fact.key,
      value: fact.value,
      source: `boundary:${input.trigger}`,
      confidence: fact.confidence,
      isPinned: Boolean(fact.load_bearing),
      isDeleted: false,
      createdAt: now as MemoryItem['createdAt'],
      updatedAt: now as MemoryItem['updatedAt'],
    });
    saved += 1;
  }
  return { saved };
}

function memorySubjectsForSession(session: AgentSession): MemorySubject[] {
  const subjects: MemorySubject[] = [
    { kind: 'agent', appId: session.appId, agentId: session.agentId },
  ];
  if (session.userId) {
    subjects.push({
      kind: 'user',
      appId: session.appId,
      userId: session.userId,
    });
  }
  if (session.conversationId) {
    subjects.push({
      kind: 'conversation',
      appId: session.appId,
      conversationId: session.conversationId,
    });
  }
  if (session.conversationId && session.threadId) {
    subjects.push({
      kind: 'thread',
      appId: session.appId,
      conversationId: session.conversationId,
      threadId: session.threadId,
    });
  }
  return subjects;
}

function subjectForFact(
  fact: ExtractedMemoryFact,
  session: AgentSession,
  defaultScope: MemoryBoundaryDefaultScope | undefined,
): MemorySubject {
  const scope = fact.scope === 'global' ? 'global' : defaultScope || fact.scope;
  if (scope === 'user') {
    return session.userId
      ? { kind: 'user', appId: session.appId, userId: session.userId }
      : { kind: 'agent', appId: session.appId, agentId: session.agentId };
  }
  if (scope === 'group') {
    if (session.conversationId && session.threadId) {
      return {
        kind: 'thread',
        appId: session.appId,
        conversationId: session.conversationId,
        threadId: session.threadId,
      };
    }
    if (session.conversationId) {
      return {
        kind: 'conversation',
        appId: session.appId,
        conversationId: session.conversationId,
      };
    }
    return { kind: 'agent', appId: session.appId, agentId: session.agentId };
  }
  return { kind: 'app', appId: session.appId };
}

function memoryIdFor(input: {
  appId: string;
  agentId: string;
  subject: MemorySubject;
  kind: string;
  key: string;
}): string {
  return `memory-item:${encodeURIComponent(
    [
      input.appId,
      input.agentId,
      input.subject.kind,
      'userId' in input.subject ? input.subject.userId : '',
      'conversationId' in input.subject ? input.subject.conversationId : '',
      'threadId' in input.subject ? input.subject.threadId : '',
      input.kind,
      input.key,
    ].join(':'),
  )}`;
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

function messageText(message: Message): string {
  return message.parts.map(messagePartText).join('\n').trim();
}
