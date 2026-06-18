import type {
  ConversationRoute,
  ThinkingOverride,
} from '../../domain/types.js';
import type { AgentCredentialProvider } from '../../domain/models/credentials.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { SkillArtifactStore } from '../../domain/ports/skill-artifact-store.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { RemoteMcpDnsValidationCache } from '../mcp/mcp-server-policy.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { ModelCatalogEntry } from '../../shared/model-catalog.js';
import type { AgentPersona } from '../../shared/agent-persona.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';

export type AgentExecutionProviderId = ExecutionProviderId;

export interface AgentExecutionRunInput {
  prompt: string;
  appId?: string;
  agentId?: string;
  model?: string;
  sessionId?: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  memoryReviewerIsControlApprover?: boolean;
  persona?: AgentPersona;
  browserProfileName?: string;
  toolPolicyRules?: string[];
  attachedSkillSourceIds?: string[];
  selectedSkillDisplays?: string[];
  attachedMcpSourceIds?: string[];
  semanticCapabilities?: SemanticCapabilityDefinition[];
  isScheduledJob?: boolean;
  jobId?: string;
  jobName?: string;
  runId?: string;
  jobModelUseKind?: 'oneTimeJob' | 'recurringJob';
  assistantName?: string;
  compiledSystemPrompt?: string;
  thinking?: ThinkingOverride;
  memoryContextBlock?: string;
  yoloMode?: YoloModeSettings;
}

export interface AgentExecutionAdapterOptions {
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
}

export interface AgentExecutionHostRuntime {
  groupDir: string;
  workspaceIpcDir: string;
  runnerDistDir: string;
}

export interface AgentExecutionCredentialProjection {
  env: Record<string, string>;
  credentialProviders: Partial<Record<string, AgentCredentialProvider>>;
  brokerProfile: string;
  brokerApplied: boolean;
  // Resolved bound model-credential auth mode id when known. Execution adapters
  // that gate on credential mode read this to enforce per-engine credential
  // policy; adapters that do not gate on it ignore the field.
  brokerAuthMode?: string;
  proxy?: {
    http?: string;
    https?: string;
  };
}

export interface AgentExecutionAdapterPrepareInput {
  group: ConversationRoute;
  input: AgentExecutionRunInput;
  hostRuntime: AgentExecutionHostRuntime;
  groupDir: string;
  effectiveModel?: string;
  effectiveModelEntry?: ModelCatalogEntry;
  modelCredentialProjection: AgentExecutionCredentialProjection;
  browserIpcEnabled: boolean;
  packageRootFromRunner: (runnerPath: string) => string;
  options?: AgentExecutionAdapterOptions;
}

export interface PreparedAgentExecution {
  providerId: AgentExecutionProviderId;
  runnerPath: string;
  runnerArgs: string[];
  runtimeConfigDir?: string;
  runnerInputPatch?: {
    modelCredentialEnv?: Record<string, string>;
    toolNetworkEnv?: Record<string, string>;
    semanticCapabilities?: SemanticCapabilityDefinition[];
  };
  sandboxRuntime?: {
    toolTempDirLeaf?: string;
    tempEnv?: (runnerTempDir: string) => NodeJS.ProcessEnv;
  };
  env: NodeJS.ProcessEnv;
  protectedFilesystemPaths: string[];
  protectedFilesystemDenyReadPaths?: string[];
  protectedFilesystemDenyWritePaths?: string[];
  runtimeDetails: string[];
  cleanup: () => void;
}

export interface AgentExecutionAdapter {
  readonly id: AgentExecutionProviderId;
  isMissingProviderSessionError?(error: string | undefined): boolean;
  prepare(
    input: AgentExecutionAdapterPrepareInput,
  ): Promise<PreparedAgentExecution>;
}
