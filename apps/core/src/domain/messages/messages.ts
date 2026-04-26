import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../conversation/conversation.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type MessageId = BrandedId<'MessageId'>;
export type ExternalMessageId = BrandedId<'ExternalMessageId'>;

export type MessageDirection = 'inbound' | 'outbound' | 'system' | 'tool';
export type MessageTrust = 'trusted' | 'untrusted' | 'system';

export interface Message {
  id: MessageId;
  appId: AppId;
  conversationId: ConversationId;
  threadId?: ConversationThreadId;
  externalRef?: ExternalRef<'message'>;
  direction: MessageDirection;
  senderUserId?: UserId;
  senderDisplayName?: string;
  trust: MessageTrust;
  createdAt: IsoTimestamp;
  receivedAt?: IsoTimestamp;
  parts: MessagePart[];
  attachments: MessageAttachment[];
}

export interface InboundMessage extends Message {
  direction: 'inbound';
  receivedAt: IsoTimestamp;
}

export interface OutboundMessage extends Message {
  direction: 'outbound';
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'code'; language?: string; code: string }
  | { kind: 'structured'; value: unknown }
  | { kind: 'tool_result'; toolId: string; value: unknown }
  | { kind: 'redacted'; reason: string };

export interface MessageAttachment {
  id: BrandedId<'MessageAttachmentId'>;
  messageId: MessageId;
  kind: 'image' | 'file' | 'audio' | 'video' | 'other';
  contentType?: string;
  sizeBytes?: number;
  externalRef?: ExternalRef<'message_attachment'>;
  storageRef?: string;
  trust: MessageTrust;
}
