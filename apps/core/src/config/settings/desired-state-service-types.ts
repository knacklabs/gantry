import type { AgentPersona } from '../../shared/agent-persona.js';
import type { AgentRelationshipMode } from '../../shared/agent-relationship-mode.js';
import type { PermissionMode } from '../../shared/permission-mode.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentRepository,
  ConversationRepository,
  McpServerRepository,
  ProviderAccountRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { RuntimeConfiguredConversation } from './runtime-settings-types.js';

export interface StoredAgentBinding {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  requiresTrigger?: boolean;
  providerAccountId?: string;
  conversationKind?: 'dm' | 'channel';
  agentConfig?: {
    model?: string;
    persona?: AgentPersona;
    relationshipMode?: AgentRelationshipMode;
    permissionMode?: PermissionMode;
  };
}

export interface ConfiguredRoutingBinding {
  agentFolder: string;
  jid: string;
  installKey?: string;
  threadId?: string;
  providerAccountId?: string;
  name?: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  model?: string;
  permissionMode?: PermissionMode;
  conversation?: RuntimeConfiguredConversation;
}

export interface SettingsDesiredStateOps {
  getAllConversationRoutes(): Promise<Record<string, StoredAgentBinding>>;
  setConversationRoute(jid: string, group: StoredAgentBinding): Promise<void>;
  deleteConversationRoute?(jid: string): Promise<void>;
}

export interface SettingsDesiredStateRepositories {
  agents: AgentRepository;
  providerAccounts?: ProviderAccountRepository;
  conversations?: ConversationRepository;
  tools: ToolCatalogRepository;
  skills: SkillCatalogRepository;
  mcpServers: McpServerRepository;
}

export interface SettingsDesiredStateServiceDeps {
  appId?: AppId;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  clock?: { now(): string };
}

export interface SettingsDesiredStateDriftReport {
  missingSettingsAgents: string[];
  dbOnlyGroupJids: string[];
  invalidReferences: string[];
}

export interface SettingsReconcileResult {
  applied: string[];
  skipped: string[];
  invalidReferences: string[];
}

export interface SettingsChangeClassification {
  liveApplied: string[];
  restartRequired: string[];
}
