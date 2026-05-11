import { ChildProcess } from 'child_process';

import { ConversationRoute, ThinkingOverride } from '../domain/types.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import type { McpServerRepository } from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../shared/model-catalog.js';
import type { AgentPersona } from '../shared/agent-persona.js';

export interface AgentInput {
  prompt: string;
  appId?: string;
  agentId?: string;
  model?: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  memoryReviewerIsControlApprover?: boolean;
  persona?: AgentPersona;
  browserProfileName?: string;
  allowedTools?: string[];
  selectedSkillIds?: string[];
  selectedMcpServerIds?: string[];
  isScheduledJob?: boolean;
  jobId?: string;
  jobModelUseKind?: 'oneTimeJob' | 'recurringJob';
  assistantName?: string;
  compiledSystemPrompt?: string;
  thinking?: ThinkingOverride;
  memoryContextBlock?: string;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  compactBoundary?: boolean;
  interactionBoundary?: 'user_interaction';
  continuedByFollowup?: boolean;
  usage?: NormalizedModelUsage;
  usageEventId?: string;
  contextUsage?: RuntimeContextUsageSnapshot;
  error?: string;
}

export interface RunAgentOptions {
  timeoutMs?: number;
  credentialBroker?: AgentCredentialBroker;
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  skillContext?: {
    appId: string;
    agentId: string;
  };
  mcpServerRepository?: McpServerRepository;
  mcpContext?: {
    appId: string;
    agentId: string;
  };
  mcpHostnameLookup?: HostnameLookup;
  mcpDnsValidationCache?: RemoteMcpDnsValidationCache;
}

export interface HostRuntimeContext {
  groupDir: string;
  globalDir?: string;
  groupIpcDir: string;
  runnerDistDir: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface RunnerProcessSpec {
  group: ConversationRoute;
  input: AgentInput;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  onProcess: (proc: ChildProcess, runHandle: string) => void;
  onOutput?: (output: AgentOutput) => Promise<void>;
  options?: RunAgentOptions;
  runnerLabel: string;
  processName: string;
  startTime: number;
  logsDir: string;
  runtimeDetails: string[];
}
