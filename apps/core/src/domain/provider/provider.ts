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
export type ProviderConnectionId = BrandedId<'ProviderConnectionId'>;
export type ConversationApproverId = BrandedId<'ConversationApproverId'>;

export interface Provider {
  id: ProviderId;
  displayName: string;
  capabilityFlags: string[];
  allowedRuntimeSecretRefs?: string[];
  createdAt: IsoTimestamp;
}

export interface ProviderConnection {
  id: ProviderConnectionId;
  appId: AppId;
  providerId: ProviderId;
  externalInstallationRef?: ExternalRef<'provider_connection'>;
  label: string;
  status: 'active' | 'disabled';
  config: Record<string, unknown>;
  runtimeSecretRefs: string[];
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

export type AgentConversationBindingStatus = 'active' | 'disabled';
export type AgentConversationBindingTriggerMode =
  | 'always'
  | 'mention'
  | 'keyword'
  | 'manual'
  | 'webhook';
export type AgentConversationBindingMemoryScope =
  | 'user'
  | 'conversation'
  | 'agent'
  | 'app';

export interface AgentConversationBinding {
  id: BrandedId<'AgentConversationBindingId'>;
  appId: AppId;
  agentId: AgentId;
  providerConnectionId: ProviderConnectionId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  externalConversationId?: ExternalConversationId;
  displayName: string;
  status: AgentConversationBindingStatus;
  triggerMode: AgentConversationBindingTriggerMode;
  triggerPattern?: string;
  requiresTrigger: boolean;
  memoryScope: AgentConversationBindingMemoryScope;
  memorySubject: MemorySubject;
  workspaceSnapshotId?: WorkspaceSnapshotId;
  permissionPolicyIds: PermissionPolicyId[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
