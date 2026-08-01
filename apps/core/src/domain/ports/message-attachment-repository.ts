import type {
  ConversationId,
  ConversationThreadId,
} from '../conversation/conversation.js';

export interface ResolvableMessageAttachment {
  id: string;
  messageId: string;
  appId: string;
  conversationId: ConversationId;
  conversationJid: string;
  threadId?: ConversationThreadId;
  providerAccountId: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  storageRef?: string;
  providerFetch?: {
    provider: string;
    kind: string;
    id: string;
    [key: string]: unknown;
  };
  deletedAt?: string;
}

export interface MaterializedMessageAttachment {
  storageRef: string;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface ProviderFetchIdentity {
  provider: string;
  kind: string;
  id: string;
}

export type AttachmentStorageClaimResult =
  | {
      status: 'materialized';
      attachment: MaterializedMessageAttachment;
    }
  | { status: 'deleted' }
  | { status: 'stale' }
  | { status: 'missing' };

export interface AttachmentTombstoneResult {
  tombstoned: boolean;
  stale?: boolean;
  storageRef?: string;
}

export interface MessageAttachmentDeletionScope {
  appId: string;
  providerId: string;
  providerAccountIds: readonly string[];
  channelId: string;
  fallbackConversationJid?: string;
  requireStoredMessageMatch?: boolean;
  externalMessageIds: readonly string[];
  deletedAt: string;
}

export interface MessageAttachmentDeletionResult {
  tombstonedAttachments: readonly {
    attachmentId: string;
    deletedAt: string;
  }[];
}

export interface MessageAttachmentRepository {
  getResolvableAttachment(
    attachmentId: string,
  ): Promise<ResolvableMessageAttachment | null>;
  setStorageRefIfAbsent(input: {
    attachmentId: string;
    expectedMessageId: string;
    expectedAppId: string;
    expectedConversationId: ConversationId;
    expectedProviderAccountId: string;
    expectedProviderFetch: ProviderFetchIdentity;
    expectedStorageRef?: string;
    storageRef: string;
    fileName?: string;
    contentType?: string;
    sizeBytes?: number;
  }): Promise<AttachmentStorageClaimResult>;
  setDeletedAt(input: {
    attachmentId: string;
    expectedMessageId: string;
    expectedAppId: string;
    expectedConversationId: ConversationId;
    expectedProviderAccountId: string;
    expectedProviderFetch: ProviderFetchIdentity;
    deletedAt: string;
  }): Promise<AttachmentTombstoneResult>;
  setDeletedAtByMessageExternalIds(
    input: MessageAttachmentDeletionScope,
  ): Promise<MessageAttachmentDeletionResult>;
  retryPendingMessageAttachmentDeletions(): Promise<boolean>;
  reclaimTombstonedStorageRef(input: {
    attachmentId: string;
    messageId: string;
    storageRef: string;
  }): Promise<void>;
}
