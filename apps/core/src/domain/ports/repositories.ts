import type {
  Agent,
  AgentConfigVersion,
  AgentConfigVersionId,
  AgentId,
} from '../agent/agent.js';
import type { App, AppId } from '../app/app.js';
import type { BrowserProfile, BrowserProfileId } from '../browser/browser.js';
import type {
  AgentChannelBinding,
  ChannelInstallation,
  ChannelInstallationId,
} from '../channel/channel.js';
import type {
  Conversation,
  ConversationId,
  ConversationThread,
  ConversationThreadId,
} from '../conversation/conversation.js';
import type { AgentRun, AgentRunEvent, AgentRunId } from '../events/events.js';
import type { Job, JobId, JobTrigger } from '../jobs/jobs.js';
import type {
  MemoryItem,
  MemoryItemId,
  MemorySubject,
} from '../memory/memory.js';
import type { Message, MessageId } from '../messages/messages.js';
import type {
  PermissionDecision,
  PermissionDecisionId,
  PermissionPolicy,
  PermissionRule,
} from '../permissions/permissions.js';
import type {
  SandboxLease,
  SandboxLeaseId,
  SandboxProfile,
  SandboxProfileId,
  WorkspaceSnapshot,
  WorkspaceSnapshotId,
} from '../sandbox/sandbox.js';
import type {
  AgentSession,
  AgentSessionId,
  ProviderSession,
  ProviderSessionId,
} from '../sessions/sessions.js';
import type { SkillCatalogItem, SkillId } from '../skills/skills.js';
import type { ToolCatalogItem, ToolId } from '../tools/tools.js';

export interface AppRepository {
  getApp(id: AppId): Promise<App | null>;
  saveApp(app: App): Promise<void>;
}

export interface AgentRepository {
  getAgent(id: AgentId): Promise<Agent | null>;
  listAgents(appId: AppId): Promise<Agent[]>;
  saveAgent(agent: Agent): Promise<void>;
}

export interface AgentConfigRepository {
  getConfigVersion(
    id: AgentConfigVersionId,
  ): Promise<AgentConfigVersion | null>;
  saveConfigVersion(version: AgentConfigVersion): Promise<void>;
}

export interface ChannelInstallationRepository {
  getChannelInstallation(
    id: ChannelInstallationId,
  ): Promise<ChannelInstallation | null>;
  saveChannelInstallation(installation: ChannelInstallation): Promise<void>;
  saveAgentChannelBinding(binding: AgentChannelBinding): Promise<void>;
  listAgentChannelBindings(appId: AppId): Promise<AgentChannelBinding[]>;
}

export interface ConversationRepository {
  getConversation(id: ConversationId): Promise<Conversation | null>;
  getThread(id: ConversationThreadId): Promise<ConversationThread | null>;
  saveConversation(conversation: Conversation): Promise<void>;
  saveThread(thread: ConversationThread): Promise<void>;
}

export interface MessageRepository {
  getMessage(id: MessageId): Promise<Message | null>;
  saveMessage(message: Message): Promise<void>;
  listMessages(input: {
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
    after?: string;
    limit?: number;
  }): Promise<Message[]>;
}

export interface AgentSessionRepository {
  getAgentSession(id: AgentSessionId): Promise<AgentSession | null>;
  saveAgentSession(session: AgentSession): Promise<void>;
}

export interface ProviderSessionRepository {
  getProviderSession(id: ProviderSessionId): Promise<ProviderSession | null>;
  saveProviderSession(session: ProviderSession): Promise<void>;
}

export interface AgentRunRepository {
  getAgentRun(id: AgentRunId): Promise<AgentRun | null>;
  saveAgentRun(run: AgentRun): Promise<void>;
  appendAgentRunEvent(event: AgentRunEvent): Promise<void>;
  listAgentRunEvents(runId: AgentRunId): Promise<AgentRunEvent[]>;
}

export interface MemoryRepository {
  getMemoryItem(id: MemoryItemId): Promise<MemoryItem | null>;
  saveMemoryItem(item: MemoryItem): Promise<void>;
  listMemoryItems(
    subject: MemorySubject,
    limit?: number,
  ): Promise<MemoryItem[]>;
}

export interface JobRepository {
  getJob(id: JobId): Promise<Job | null>;
  saveJob(job: Job): Promise<void>;
  listJobs(appId: AppId): Promise<Job[]>;
  saveJobTrigger(trigger: JobTrigger): Promise<void>;
}

export interface ToolCatalogRepository {
  getTool(id: ToolId): Promise<ToolCatalogItem | null>;
  saveTool(item: ToolCatalogItem): Promise<void>;
}

export interface SkillCatalogRepository {
  getSkill(id: SkillId): Promise<SkillCatalogItem | null>;
  saveSkill(item: SkillCatalogItem): Promise<void>;
}

export interface PermissionRepository {
  savePolicy(policy: PermissionPolicy): Promise<void>;
  saveRule(rule: PermissionRule): Promise<void>;
  saveDecision(decision: PermissionDecision): Promise<void>;
  getDecision(id: PermissionDecisionId): Promise<PermissionDecision | null>;
}

export interface SandboxRepository {
  getSandboxProfile(id: SandboxProfileId): Promise<SandboxProfile | null>;
  saveSandboxProfile(profile: SandboxProfile): Promise<void>;
  getSandboxLease(id: SandboxLeaseId): Promise<SandboxLease | null>;
  saveSandboxLease(lease: SandboxLease): Promise<void>;
  saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
  getWorkspaceSnapshot(
    id: WorkspaceSnapshotId,
  ): Promise<WorkspaceSnapshot | null>;
}

export interface BrowserProfileRepository {
  getBrowserProfile(id: BrowserProfileId): Promise<BrowserProfile | null>;
  saveBrowserProfile(profile: BrowserProfile): Promise<void>;
}
