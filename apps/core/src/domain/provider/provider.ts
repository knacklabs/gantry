import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  ExternalConversationId,
} from '../conversation/conversation.js';
import type { MemorySubject } from '../memory/memory.js';
import type { PermissionPolicyId } from '../permissions/permissions.js';
import type { WorkspaceSnapshotId } from '../sandbox/sandbox.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type ProviderId = BrandedId<'ProviderId'>;
export type ProviderAccountId = BrandedId<'ProviderAccountId'>;
export type ConversationApproverId = BrandedId<'ConversationApproverId'>;
export type ProviderRuntimeSecretRefs = Record<string, string>;

export interface Provider {
  id: ProviderId;
  displayName: string;
  capabilityFlags: string[];
  allowedRuntimeSecretKeys?: string[];
  createdAt: IsoTimestamp;
}

export interface ProviderAccount {
  id: ProviderAccountId;
  appId: AppId;
  agentId: AgentId;
  providerId: ProviderId;
  externalIdentityRef?: ExternalRef<'provider_account'>;
  label: string;
  status: 'active' | 'disabled';
  config: Record<string, unknown>;
  runtimeSecretRefs: ProviderRuntimeSecretRefs;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ConversationApprover {
  id: ConversationApproverId;
  appId: AppId;
  conversationId: ConversationId;
  externalUserId: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export type ConversationInstallStatus = 'active' | 'disabled';
export type ConversationInstallMemoryScope =
  | 'user'
  | 'conversation'
  | 'agent'
  | 'app';
export type ConversationInstallSenderPolicy = 'provider_native';
export type ConversationInstallControlPolicy = 'conversation_approvers';

export interface ConversationInstall {
  id: BrandedId<'ConversationInstallId'>;
  appId: AppId;
  agentId: AgentId;
  providerAccountId: ProviderAccountId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  externalConversationId?: ExternalConversationId;
  displayName: string;
  status: ConversationInstallStatus;
  senderPolicy: ConversationInstallSenderPolicy;
  controlPolicy: ConversationInstallControlPolicy;
  memoryScope: ConversationInstallMemoryScope;
  memorySubject: MemorySubject;
  workspaceSnapshotId?: WorkspaceSnapshotId;
  permissionPolicyIds: PermissionPolicyId[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
