import type { AgentPersona } from '../../shared/agent-persona.js';
import type { AppId } from '../../domain/app/app.js';
import type { GuardrailConfig } from '../../domain/types.js';
import type {
  AgentRepository,
  ConversationRepository,
  McpServerRepository,
  ProviderConnectionRepository,
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
  conversationKind?: 'dm' | 'channel';
  agentConfig?: {
    model?: string;
    persona?: AgentPersona;
    guardrail?: GuardrailConfig;
  };
  // Marks this binding as a clone-source template for inbound messages whose
  // external id has no specific route yet. Mirrored from settings.yaml
  // conversations.<id>.template; the runtime routing layer reads this flag.
  isTemplate?: boolean;
}

export interface ConfiguredRoutingBinding {
  agentFolder: string;
  jid: string;
  name?: string;
  trigger: string;
  addedAt: string;
  requiresTrigger: boolean;
  model?: string;
  conversation?: RuntimeConfiguredConversation;
}

export interface SettingsDesiredStateOps {
  getAllConversationRoutes(): Promise<Record<string, StoredAgentBinding>>;
  setConversationRoute(jid: string, group: StoredAgentBinding): Promise<void>;
  deleteConversationRoute?(jid: string): Promise<void>;
}

export interface SettingsDesiredStateRepositories {
  agents: AgentRepository;
  providerConnections?: ProviderConnectionRepository;
  conversations?: ConversationRepository;
  tools: ToolCatalogRepository;
  skills: SkillCatalogRepository;
  mcpServers: McpServerRepository;
}

export interface SettingsDesiredStateServiceDeps {
  appId?: AppId;
  ops: SettingsDesiredStateOps;
  repositories: SettingsDesiredStateRepositories;
  guardrailPolicies?: {
    isRegistered(policyId: string): boolean;
    registeredIds(): readonly string[];
  };
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
