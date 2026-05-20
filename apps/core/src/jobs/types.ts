import type { ChildProcess } from 'child_process';

import type {
  ConversationRoute,
  StreamingChunkOptions,
} from '../domain/types.js';
import type {
  RuntimeAgentSessionRepository,
  RuntimeJobRepository,
} from '../domain/repositories/ops-repo.js';
import type { GroupQueue } from '../runtime/group-queue.js';
import type { spawnAgent } from '../runtime/agent-spawn.js';
import type { SchedulerSendMessage } from './delivery.js';
import type { SessionMemoryCollector } from '../domain/ports/session-memory-collector.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type { JobReadinessBrowserStatus } from '../application/jobs/job-readiness-service.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';

export interface SchedulerDependencies {
  conversationRoutes: () => Record<string, ConversationRoute>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    runHandle: string,
    groupFolder: string,
    stopAliasJids?: string[],
  ) => void;
  sendMessage: SchedulerSendMessage;
  sendStreamingChunk?: (
    jid: string,
    rawText: string,
    options?: StreamingChunkOptions,
  ) => Promise<boolean>;
  resetStreaming?: (jid: string) => void;
  onSchedulerChanged?: (jobId?: string) => void;
  runAgent?: typeof spawnAgent;
  collectSessionMemory?: SessionMemoryCollector;
  opsRepository: RuntimeJobRepository & RuntimeAgentSessionRepository;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  getMcpHostnameLookup?: () => HostnameLookup | undefined;
  getMcpDnsValidationCache?: () => RemoteMcpDnsValidationCache | undefined;
  getSkillArtifactStore?: () => SkillArtifactStore | undefined;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  getBrowserStatus?: (
    profileName: string,
  ) => Promise<JobReadinessBrowserStatus | undefined>;
  executionAdapter?: AgentExecutionAdapter;
  closeBrowserSession?: (profileName: string) => Promise<{
    closed: boolean;
    reason?: string;
    elapsedMs?: number;
  }>;
  closeBrowserToolBackends?: (profileName: string) => Promise<void>;
}

export type JobTurnContext = Awaited<
  ReturnType<
    NonNullable<SchedulerDependencies['opsRepository']['getAgentTurnContext']>
  >
>;

export interface SchedulerDispatchPayload {
  jobId: string;
  runId?: string | null;
  triggerId?: string | null;
  scheduledFor?: string | null;
}
