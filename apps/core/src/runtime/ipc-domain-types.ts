import { AvailableGroup } from './agent-spawn.js';
import {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ConversationRoute,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../domain/types.js';
import type { RuntimeJobRepository } from '../domain/repositories/ops-repo.js';
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
} from '../application/jobs/job-management-types.js';
import type { BrowserBackendAction } from '../shared/browser-backend-actions.js';
import type { BrowserSessionStatus } from './browser-capability-types.js';
import type { BrowserUsageSettings } from './browser-usage-governor.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: { threadId?: string },
  ) => Promise<void>;
  conversationRoutes: () => Record<string, ConversationRoute>;
  registerGroup: (
    jid: string,
    group: ConversationRoute,
  ) => Promise<void> | void;
  syncGroups: (force: boolean) => Promise<void>;
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
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  renderAgentTodo?: (jid: string, render: AgentTodoRender) => Promise<void>;
  mcpHostnameLookup?: HostnameLookup;
  opsRepository: RuntimeJobRepository;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  runApprovedCommand?: (input: {
    argv: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    stderrMaxBytes?: number;
    redactOutput?: (value: string) => string;
  }) => Promise<void>;
  getPermissionRepository?: () => PermissionRepository | undefined;
  getFileArtifactStore?: () => FileArtifactStore | undefined;
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
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
