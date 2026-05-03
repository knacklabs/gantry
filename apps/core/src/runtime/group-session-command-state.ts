import type { OpsRepository } from '../domain/repositories/ops-repo.js';
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
  ops: () => OpsRepository;
  group: ArchiveSessionInput['group'];
  chatJid: string;
  threadId: string | null;
  defaultScope: 'user' | 'group';
  collectMemory?: SessionMemoryCollector;
}) {
  return async (cause: ArchiveSessionInput['cause'] = 'new-session') => {
    await archiveCurrentRuntimeSession({
      ops: input.ops(),
      group: input.group,
      chatJid: input.chatJid,
      threadId: input.threadId,
      cause,
      defaultScope: input.defaultScope,
      ...(input.collectMemory ? { collectMemory: input.collectMemory } : {}),
    });
  };
}

export function createSaveProcedureHandler(input: {
  folder: string;
  threadId?: string | null;
  isAdminWrite: boolean;
}) {
  return async ({ title, body }: { title: string; body: string }) =>
    saveGroupProcedureMemory({
      ['group' + 'Folder']: input.folder,
      threadId: input.threadId,
      isAdminWrite: input.isAdminWrite,
      title,
      body,
    } as Parameters<typeof saveGroupProcedureMemory>[0]);
}

export function createSenderCommandPolicy(input: {
  chatJid: string;
  group: SenderPolicyGroup;
  isMainGroup: boolean;
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
      const reqTrigger =
        !input.isMainGroup && input.group.requiresTrigger !== false;
      return (
        input.isMainGroup ||
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
