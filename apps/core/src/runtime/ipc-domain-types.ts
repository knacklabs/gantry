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
  PermissionRepository,
  ToolCatalogRepository,
} from '../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { CredentialBrokerProfile } from '../domain/models/credentials.js';
import type { JobControlPort } from '../application/jobs/job-management-types.js';
import type { BrowserIpcAction } from '@myclaw/contracts';
import type { BrowserSessionStatus } from './browser-capability-types.js';

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
    groupFolder: string,
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
  mcpHostnameLookup?: HostnameLookup;
  opsRepository: RuntimeJobRepository;
  getToolRepository?: () => ToolCatalogRepository | undefined;
  getPermissionRepository?: () => PermissionRepository | undefined;
  getJobControl?: () => JobControlPort | undefined;
  mirrorAgentToolRulesToSettings?: (
    sourceAgentFolder: string,
    rules: string[],
    options?: { appId?: string },
  ) => Promise<void> | void;
  reloadRuntimeState?: () => Promise<void>;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getCredentialBrokerProfile?: () => CredentialBrokerProfile;
  callBrowserTool?: (input: {
    toolName: BrowserIpcAction;
    arguments: Record<string, unknown>;
    session: BrowserSessionStatus;
    fileAccessRoot: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  closeBrowserToolBackends?: (profileName?: string) => Promise<void>;
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
