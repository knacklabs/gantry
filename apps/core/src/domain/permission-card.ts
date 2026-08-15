import type {
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalRequest,
} from './types.js';

export interface PermissionCardMessageView {
  request: PermissionApprovalRequest;
  providerAlias: string;
  fullView?: {
    label: string;
    title: string;
    filename: string;
    content: string;
  };
}

export interface PreparedPermissionCardSend {
  send(): Promise<{
    delivery: MessageDeliveryResult;
    locator: {
      provider: string;
      conversationId: string;
      messageId: string;
      threadId?: string;
    };
  }>;
}

export interface PreparedPermissionCardSink {
  preparePermissionCardSend(
    jid: string,
    text: string,
    options: MessageSendOptions & {
      permissionCardView: PermissionCardMessageView;
    },
  ): PreparedPermissionCardSend;
}
