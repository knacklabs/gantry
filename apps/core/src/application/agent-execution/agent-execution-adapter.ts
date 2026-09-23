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
import type { PermissionMode } from '../../shared/permission-mode.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import type { AgentAccessSnapshot } from './agent-access-snapshot.js';
import type { ProviderSessionContinuity } from '../../domain/repositories/ops-repo.js';
import type { AgentExecutionAdapterRegistry } from './agent-execution-adapter-registry.js';

export type AgentExecutionProviderId = ExecutionProviderId;

export interface DeepAgentSkillFileProjection {
  content: string;
  mimeType: string;
  created_at: string;
  modified_at: string;
}

export interface DeepAgentSkillProjection {
  sources: string[];
  files: Record<string, DeepAgentSkillFileProjection>;
  selectedSkillIds: string[];
  skillCount: number;
  fileCount: number;
  contentBytes: number;
}

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
  providerSessionAccessFingerprint?: string;
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
  permissionMode: PermissionMode;
}

export interface AgentExecutionAdapterOptions {
  signal?: AbortSignal;
  credentialBroker?: AgentCredentialBroker;
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  skillContext?: {
    appId: string;
    agentId: string;
  };
  accessSnapshot?: AgentAccessSnapshot;
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
  runtimeStorage?: {
    postgresUrl: string | null;
    postgresUrlEnv: string;
    postgresSchema: string;
  };
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
    deepAgentCheckpointer?: {
      databaseUrl: string;
      schema: string;
      proxyUrl?: string;
    };
    deepAgentSkills?: DeepAgentSkillProjection;
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
  readonly providerSessionContinuity: ProviderSessionContinuity;
  isMissingProviderSessionError?(error: string | undefined): boolean;
  sessionCompactionPrompt?(): string | undefined;
  prepare(
    input: AgentExecutionAdapterPrepareInput,
  ): Promise<PreparedAgentExecution>;
}

export function providerSessionContinuityForExecutionProvider(input: {
  executionProviderId: string;
  registry?: AgentExecutionAdapterRegistry;
  fallback?: Pick<AgentExecutionAdapter, 'id' | 'providerSessionContinuity'>;
}): ProviderSessionContinuity {
  const adapter =
    input.registry?.get(input.executionProviderId) ??
    (input.fallback?.id === input.executionProviderId
      ? input.fallback
      : undefined);
  if (!adapter) {
    throw new Error(
      `Unsupported model execution provider: ${input.executionProviderId}`,
    );
  }
  return adapter.providerSessionContinuity;
}

export function durableExecutionProviderIds(
  registry: AgentExecutionAdapterRegistry,
): AgentExecutionProviderId[] {
  return registry
    .list()
    .filter((adapter) => adapter.providerSessionContinuity === 'durable_resume')
    .map((adapter) => adapter.id);
}
