import { AvailableGroup, spawnAgent } from './agent-spawn.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  RichInteractionRequest,
  ConversationRoute,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type {
  RuntimeJobRepository,
  RuntimeMessageRepository,
} from '../domain/repositories/ops-repo.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  PermissionRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import type { AgentTodoRender } from '../domain/ports/task-lifecycle.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { CredentialBrokerProfile } from '../domain/models/credentials.js';
import type {
  JobControlPort,
  JobManagementServiceDeps,
  RuntimeEventPublisherPort,
} from '../application/jobs/job-management-types.js';
import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { RunnerSandboxProvider } from '../shared/runner-sandbox-provider.js';
import type { BrowserBackendAction } from '../shared/browser-backend-actions.js';
import type { BrowserSessionStatus } from './browser-capability-types.js';
import type { BrowserUsageSettings } from './browser-usage-governor.js';
import type { EgressSettings } from '../shared/egress-policy.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { MessageSendOptions } from '../domain/types.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import type { PermissionClassifierPromptConsultInput } from './permission-classifier.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import type { PermissionPromotionRepository } from '../domain/ports/permission-promotion.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void>;
  conversationRoutes: () => Record<string, ConversationRoute>;
  registerGroup: (
    jid: string,
    group: ConversationRoute,
  ) => Promise<void> | void;
  syncGroups: (force: boolean) => Promise<void>;
  getConversationThreadHistory?: (input: {
    sourceAgentFolder: string;
    chatJid: string;
    threadId: string;
    limit: number;
  }) => Promise<{
    messages: Array<{
      id: string;
      createdAt: string;
      direction: string;
      senderDisplayName?: string;
      text: string;
    }>;
  }>;
  getAvailableGroups: () => Promise<AvailableGroup[]> | AvailableGroup[];
  writeGroupsSnapshot: (
    workspaceFolder: string,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => Promise<void> | void;
  onSchedulerChanged: (jobId?: string) => void;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  isControlApproverAllowed?: (input: {
    conversationJid: string;
    providerAccountId?: string;
    userId: string;
    sourceAgentFolder: string;
    decisionPolicy?: 'same_channel';
  }) => Promise<boolean>;
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  renderAgentTodo?: (
    jid: string,
    render: AgentTodoRender,
    options?: { providerAccountId?: string },
  ) => Promise<boolean>;
  renderRichInteraction?: (
    jid: string,
    request: RichInteractionRequest,
    options?: { providerAccountId?: string },
  ) => Promise<boolean>;
  mcpHostnameLookup?: HostnameLookup;
  opsRepository: RuntimeJobRepository;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  getSkillArtifactStore?: () => SkillArtifactStore | undefined;
  getMcpDnsValidationCache?: () => RemoteMcpDnsValidationCache | undefined;
  runAgent?: typeof spawnAgent;
  executionAdapter?: AgentExecutionAdapter;
  executionAdapters?: AgentExecutionAdapterRegistry;
  runnerSandboxProvider?: RunnerSandboxProvider;
  runApprovedCommand?: (input: {
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    stdoutMaxBytes?: number;
    stderrMaxBytes?: number;
    redactOutput?: (value: string) => string;
  }) => Promise<{ stdout?: string; stderr?: string } | void>;
  getPermissionRepository?: () => PermissionRepository | undefined;
  getPermissionPromotionRepository?: () =>
    | PermissionPromotionRepository
    | undefined;
  getFileArtifactStore?: () => FileArtifactStore | undefined;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  classifierConsult?: PermissionClassifierPromptConsultInput['classifierConsult'];
  getPermissionRuntimeSettings?: () => {
    agents: Record<
      string,
      { permissionMode?: PermissionMode } | null | undefined
    >;
    permissions: { autoMode: { model?: string } };
    memory: { llm: { models: { extractor: string } } };
  };
  getPermissionMessageRepository?: () => Pick<
    RuntimeMessageRepository,
    'getRecentTopLevelMessagesBefore' | 'getLatestThreadMessages'
  >;
  subscribeRuntimeEvents?: RuntimeEventPublisherPort['subscribe'];
  getEgressSettings?: () => EgressSettings;
  getJobControl?: () => JobControlPort | undefined;
  mirrorAgentToolRulesToSettings?: (
    sourceAgentFolder: string,
    rules: string[],
    options?: { appId?: string; mode?: 'add' | 'remove' },
  ) => Promise<void> | void;
  reloadRuntimeState?: () => Promise<void>;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getCredentialBrokerProfile?: () => CredentialBrokerProfile;
  callBrowserTool?: (input: {
    toolName: BrowserBackendAction;
    arguments: Record<string, unknown>;
    session: BrowserSessionStatus;
    fileAccessRoot: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  publishBrowserJobActivity?: (input: {
    jobId: string;
    runId: string;
    tool: 'Browser';
    publicToolName?: string;
    action: BrowserBackendAction;
    ok: boolean;
    elapsedMs: number;
    normalizedSite?: string | null;
    policyMode?: string | null;
    warning?: string | null;
    error?: string | null;
  }) => Promise<void> | void;
  getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
  closeBrowserToolBackends?: (profileName?: string) => Promise<void>;
  getBrowserUsageSettings?: () =>
    | BrowserUsageSettings
    | undefined
    | Promise<BrowserUsageSettings | undefined>;
}

export interface IpcDomainContext {
  sourceAgentFolder: string;
  browserProfileName?: string;
  ipcBaseDir: string;
  deps: IpcDeps;
}

export interface IpcDomainHandler<TRequest, TResponse = void> {
  handle(request: TRequest, context: IpcDomainContext): Promise<TResponse>;
}
