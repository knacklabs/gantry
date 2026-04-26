import type { AppId } from '../app/app.js';
import type { ChannelInstallationId } from '../channel/channel.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type ConversationId = BrandedId<'ConversationId'>;
export type ConversationThreadId = BrandedId<'ConversationThreadId'>;
export type ExternalConversationId = BrandedId<'ExternalConversationId'>;
export type UserId = BrandedId<'UserId'>;

export interface Conversation {
  id: ConversationId;
  appId: AppId;
  channelInstallationId: ChannelInstallationId;
  externalRef?: ExternalRef<'conversation'>;
  kind: 'direct' | 'group' | 'channel' | 'service' | 'web';
  title?: string;
  status: 'active' | 'archived' | 'disabled';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface ConversationThread {
  id: ConversationThreadId;
  appId: AppId;
  conversationId: ConversationId;
  externalRef?: ExternalRef<'conversation_thread'>;
  title?: string;
  status: 'active' | 'archived';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
