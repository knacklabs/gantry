import type { RuntimeAgentSessionRepository } from '../domain/repositories/ops-repo.js';
import type { NewMessage } from '../domain/types.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import {
  isSenderControlAllowed,
  isTriggerAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { archiveCurrentRuntimeSession } from './session-resume-runtime.js';
import { saveGroupProcedureMemory } from './group-memory-commands.js';
import { resolveRuntimeExecutionProviderId } from './execution-provider-id.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';

type ArchiveSessionInput = Parameters<typeof archiveCurrentRuntimeSession>[0];
type SenderPolicyGroup = {
  folder: string;
  requiresTrigger?: boolean;
};

export function createAdvanceCursorHandler(input: {
  queueJid: string;
  setCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => Promise<void> | void;
  warn: (err: unknown) => void;
}) {
  return (message: Pick<NewMessage, 'timestamp' | 'id'>) => {
    input.setCursor(
      input.queueJid,
      encodeGroupMessageCursor(toGroupMessageCursor(message)),
    );
    void Promise.resolve(input.saveState()).catch(input.warn);
  };
}

export function createArchiveCurrentSessionHandler(input: {
  ops: () => RuntimeAgentSessionRepository;
  appId?: string;
  group: ArchiveSessionInput['group'];
  chatJid: string;
  threadId: string | null;
  defaultScope: 'user' | 'group';
  memoryUserId?: string;
  collectMemory?: SessionMemoryCollector;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
}) {
  return async (cause: ArchiveSessionInput['cause'] = 'new-session') => {
    await archiveCurrentRuntimeSession({
      ops: input.ops(),
      appId: input.appId,
      group: input.group,
      chatJid: input.chatJid,
      threadId: input.threadId,
      cause,
      defaultScope: input.defaultScope,
      memoryUserId: input.memoryUserId,
      executionProviderId: resolveRuntimeExecutionProviderId(
        input.executionAdapter,
      ),
      ...(input.collectMemory ? { collectMemory: input.collectMemory } : {}),
    });
  };
}

export function createPrepareSessionArchiveHandler(input: {
  ops: () => RuntimeAgentSessionRepository;
  appId?: string;
  group: ArchiveSessionInput['group'];
  chatJid: string;
  threadId: string | null;
  defaultScope: 'user' | 'group';
  memoryUserId?: string;
  collectMemory?: SessionMemoryCollector;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
}) {
  return async (_cause: 'new-session') => {
    const ops = input.ops();
    const turnContext = await ops.getAgentTurnContext?.({
      appId: input.appId,
      agentFolder: input.group.folder,
      executionProviderId: resolveRuntimeExecutionProviderId(
        input.executionAdapter,
      ),
      conversationJid: input.chatJid,
      threadId: input.threadId,
      conversationKind: input.group.conversationKind,
      memoryUserId: input.memoryUserId,
      hydrateMemory: false,
    });
    if (!turnContext?.agentSessionId || !input.collectMemory) {
      return undefined;
    }
    const agentSessionId = turnContext.agentSessionId;
    return async () => {
      await input.collectMemory?.({
        agentSessionId,
        trigger: 'session-end',
        defaultScope: input.defaultScope,
      });
    };
  };
}

export function createSessionArchiveHandlers(
  input: Parameters<typeof createArchiveCurrentSessionHandler>[0],
) {
  return {
    archiveCurrentSession: createArchiveCurrentSessionHandler(input),
    prepareSessionArchive: createPrepareSessionArchiveHandler(input),
  };
}

export function createSaveProcedureHandler(input: {
  folder: string;
  conversationId: string;
  userId?: string;
  defaultScope: 'user' | 'group';
  threadId?: string | null;
  isAdminWrite: boolean;
}) {
  return async ({ title, body }: { title: string; body: string }) =>
    saveGroupProcedureMemory({
      folder: input.folder,
      conversationId: input.conversationId,
      userId: input.userId,
      defaultScope: input.defaultScope,
      threadId: input.threadId,
      isAdminWrite: input.isAdminWrite,
      title,
      body,
    } as Parameters<typeof saveGroupProcedureMemory>[0]);
}

export function createSenderCommandPolicy(input: {
  chatJid: string;
  group: SenderPolicyGroup;
  triggerPattern: RegExp;
}) {
  return {
    isSenderControlAllowlisted: (msg: NewMessage) =>
      isSenderControlAllowed(
        input.chatJid,
        msg.sender,
        loadSenderControlAllowlist(),
        input.group.folder,
      ),
    canSenderInteract: (msg: NewMessage) => {
      const hasTrigger = input.triggerPattern.test(msg.content.trim());
      const reqTrigger = input.group.requiresTrigger !== false;
      return (
        !reqTrigger ||
        (hasTrigger &&
          (msg.is_from_me ||
            isTriggerAllowed(
              input.chatJid,
              msg.sender,
              loadSenderAllowlist(),
              input.group.folder,
            )))
      );
    },
  };
}
