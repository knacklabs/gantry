import type { NewMessage } from '../types.js';

export interface ConversationContextHydrationRequest {
  conversationJid: string;
  threadId?: string | null;
  latestMessage: Pick<
    NewMessage,
    'id' | 'timestamp' | 'external_message_id' | 'thread_id'
  >;
  limits: {
    channelMessages: number;
    threadMessages: number;
  };
}

export interface ConversationContextHydrationResult {
  providerId: string;
  attempted: boolean;
  skipped?: boolean;
  failed?: boolean;
  reason?: string;
  messages?: NewMessage[];
}
