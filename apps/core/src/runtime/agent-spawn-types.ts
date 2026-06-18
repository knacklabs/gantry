import { ChildProcess } from 'child_process';

import { ConversationRoute, ThinkingOverride } from '../domain/types.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
} from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../shared/model-catalog.js';
import type { AgentPersona } from '../shared/agent-persona.js';
import type { YoloModeSettings } from '../shared/yolo-mode-policy.js';
import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import type { RunnerStartupHostPhaseTimings } from './agent-spawn-startup-timing.js';
import type {
  RunnerSandboxProvider,
  RunnerSandboxSpawnInput,
} from '../shared/runner-sandbox-provider.js';

export interface AgentInput {
  prompt: string;
  appId?: string;
  agentId?: string;
  model?: string;
  sessionId?: string;
  workspaceFolder: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  memoryReviewerIsControlApprover?: boolean;
  persona?: AgentPersona;
  browserProfileName?: string;
  toolPolicyRules?: string[];
  toolAccessRequirements?: string[];
  attachedSkillSourceIds?: string[];
  selectedSkillDisplays?: string[];
  attachedMcpSourceIds?: string[];
  semanticCapabilities?: SemanticCapabilityDefinition[];
  hideAuthorityTools?: boolean;
  isScheduledJob?: boolean;
  jobId?: string;
  jobName?: string;
  runId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  jobModelUseKind?: 'oneTimeJob' | 'recurringJob';
  assistantName?: string;
  compiledSystemPrompt?: string;
  thinking?: ThinkingOverride;
  memoryContextBlock?: string;
  yoloMode?: YoloModeSettings;
  runtimeAccess?: CapabilityRuntimeAccess[];
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  providerSession?: AgentOutputProviderSession;
  newSessionId?: string;
  // Standalone up-front session-id frame (lane-neutral). Excluded from
  // isAgentTurnCompleteMarker so an early session-persistence frame is not
  // mistaken for turn completion. The session id still persists via
  // providerSessionExternalSessionId (reads newSessionId).
  sessionInit?: boolean;
  compactBoundary?: boolean;
  interactionBoundary?: 'user_interaction';
  continuedByFollowup?: boolean;
  usage?: NormalizedModelUsage;
  usageEventId?: string;
  contextUsage?: RuntimeContextUsageSnapshot;
  error?: string;
  runtimeEvents?: AgentOutputRuntimeEvent[];
}

export interface AgentOutputProviderSession {
  externalSessionId: string;
}

export interface AgentOutputRuntimeEvent {
  appId?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string;
  eventType: string;
  actor?: string;
  responseMode?: 'sse' | 'webhook' | 'both' | 'none';
  payload: unknown;
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
  capabilitySecretRepository?: CapabilitySecretRepository;
  mcpContext?: {
    appId: string;
    agentId: string;
  };
  mcpHostnameLookup?: HostnameLookup;
  mcpDnsValidationCache?: RemoteMcpDnsValidationCache;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  executionAdapter?: AgentExecutionAdapter;
  executionAdapters?: AgentExecutionAdapterRegistry;
  runnerSandboxProvider: RunnerSandboxProvider;
}

export interface HostRuntimeContext {
  groupDir: string;
  workspaceIpcDir: string;
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
  startupHostPhases?: RunnerStartupHostPhaseTimings;
  logsDir: string;
  runtimeDetails: string[];
  sandbox: Omit<RunnerSandboxSpawnInput, 'command' | 'args' | 'env'>;
}
