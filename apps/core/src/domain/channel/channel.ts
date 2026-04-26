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

export type ChannelProviderId = BrandedId<'ChannelProviderId'>;
export type ChannelInstallationId = BrandedId<'ChannelInstallationId'>;

export interface ChannelProvider {
  id: ChannelProviderId;
  displayName: string;
  capabilityFlags: string[];
  createdAt: IsoTimestamp;
}

export interface ChannelInstallation {
  id: ChannelInstallationId;
  appId: AppId;
  providerId: ChannelProviderId;
  externalInstallationRef?: ExternalRef<'channel_installation'>;
  label: string;
  status: 'active' | 'disabled';
  runtimeSecretRefs: string[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AgentChannelBinding {
  id: BrandedId<'AgentChannelBindingId'>;
  appId: AppId;
  agentId: AgentId;
  channelInstallationId: ChannelInstallationId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  externalConversationId?: ExternalConversationId;
  displayName: string;
  triggerPattern?: string;
  requiresTrigger: boolean;
  isAdminBinding: boolean;
  memorySubject: MemorySubject;
  workspaceSnapshotId?: WorkspaceSnapshotId;
  permissionPolicyIds: PermissionPolicyId[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
