import type { ChildProcess } from 'child_process';

import type {
  MessageSendOptions,
  ProgressUpdateOptions,
  RegisteredGroup,
  StreamingChunkOptions,
  ThinkingOverride,
} from '../domain/types.js';
import type { OpsRepository } from '../domain/repositories/ops-repo.js';
import type { AvailableGroup, spawnAgent } from './agent-spawn.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';

export interface GroupProcessor {
  processGroupMessages: (
    chatJid: string,
    options?: { queued?: boolean },
  ) => Promise<boolean>;
}

export interface GroupProcessingDeps {
  channelRuntime: {
    hasChannel: (chatJid: string) => boolean;
    supportsStreaming: (chatJid: string) => boolean;
    supportsProgress: (chatJid: string) => boolean;
    sendMessage: (
      chatJid: string,
      rawText: string,
      options?: MessageSendOptions,
    ) => Promise<void>;
    sendStreamingChunk: (
      chatJid: string,
      rawText: string,
      options?: StreamingChunkOptions,
    ) => Promise<boolean>;
    resetStreaming: (chatJid: string) => void;
    setTyping: (chatJid: string, isTyping: boolean) => Promise<void>;
    sendProgressUpdate: (
      chatJid: string,
      text: string,
      options?: ProgressUpdateOptions,
    ) => Promise<void>;
  };
  getGroup: (chatJid: string) => RegisteredGroup | undefined;
  getSession: (
    groupFolder: string,
    threadId?: string | null,
  ) => string | undefined;
  setSession: (
    groupFolder: string,
    sessionId: string,
    threadId?: string | null,
    metadata?: {
      chatJid?: string;
      artifactRef?: string | null;
    },
  ) => Promise<void> | void;
  clearSession: (
    groupFolder: string,
    threadId?: string | null,
  ) => Promise<void> | void;
  clearCachedSession?: (
    groupFolder: string,
    threadId?: string | null,
  ) => Promise<void> | void;
  getCursor: (chatJid: string) => Promise<string> | string;
  setCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => Promise<void> | void;
  setGroupModelOverride: (
    chatJid: string,
    model: string | undefined,
  ) => Promise<void> | void;
  setGroupThinkingOverride: (
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ) => Promise<void> | void;
  getAvailableGroups: () => Promise<AvailableGroup[]> | AvailableGroup[];
  getRegisteredJids: () => Set<string>;
  queue: {
    closeStdin: (chatJid: string) => void;
    notifyIdle: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
    registerProcess: (
      groupJid: string,
      proc: ChildProcess,
      containerName: string,
      groupFolder?: string,
      stopAliasJids?: string | string[],
      threadId?: string | null,
    ) => void;
  };
  runAgent?: typeof spawnAgent;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  opsRepository?: OpsRepository;
  getOpsRepository?: () => OpsRepository;
}
