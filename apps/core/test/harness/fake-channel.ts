import type {
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '@core/core/types.js';

export interface OutboundMessageRecord {
  chatJid: string;
  text: string;
  options?: MessageSendOptions;
}

export interface ProgressRecord {
  chatJid: string;
  text: string;
  options?: ProgressUpdateOptions;
}

export interface TypingRecord {
  chatJid: string;
  isTyping: boolean;
}

export interface FakeChannelRuntimeOptions {
  sendMessage?: (
    chatJid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void> | void;
  sendStreamingChunk?: (
    chatJid: string,
    text: string,
    options?: StreamingChunkOptions,
  ) => Promise<void> | void;
  permissionDecision?:
    | PermissionApprovalDecision
    | ((
        jid: string,
        request: PermissionApprovalRequest,
      ) => Promise<PermissionApprovalDecision> | PermissionApprovalDecision);
  userAnswer?:
    | UserQuestionResponse
    | ((
        jid: string,
        request: UserQuestionRequest,
      ) => Promise<UserQuestionResponse> | UserQuestionResponse);
}

export function createFakeChannelRuntime(
  ownsJid: (chatJid: string) => boolean,
  config: FakeChannelRuntimeOptions = {},
) {
  const outbound: OutboundMessageRecord[] = [];
  const streaming: Array<{
    chatJid: string;
    text: string;
    options?: StreamingChunkOptions;
  }> = [];
  const progress: ProgressRecord[] = [];
  const typing: TypingRecord[] = [];
  const permissionRequests: Array<{
    jid: string;
    request: PermissionApprovalRequest;
  }> = [];
  const userQuestions: Array<{ jid: string; request: UserQuestionRequest }> =
    [];

  return {
    outbound,
    streaming,
    progress,
    typing,
    permissionRequests,
    userQuestions,
    runtime: {
      hasChannel: (chatJid: string) => ownsJid(chatJid),
      supportsStreaming: () => false,
      supportsProgress: () => true,
      sendMessage: async (
        chatJid: string,
        text: string,
        options?: MessageSendOptions,
      ) => {
        await config.sendMessage?.(chatJid, text, options);
        outbound.push({ chatJid, text, options });
      },
      sendStreamingChunk: async (
        chatJid: string,
        text: string,
        options?: StreamingChunkOptions,
      ) => {
        await config.sendStreamingChunk?.(chatJid, text, options);
        streaming.push({ chatJid, text, options });
      },
      resetStreaming: () => {},
      setTyping: async (chatJid: string, isTyping: boolean) => {
        typing.push({ chatJid, isTyping });
      },
      sendProgressUpdate: async (
        chatJid: string,
        text: string,
        options?: ProgressUpdateOptions,
      ) => {
        progress.push({ chatJid, text, options });
      },
      requestPermissionApproval: async (
        jid: string,
        request: PermissionApprovalRequest,
      ) => {
        permissionRequests.push({ jid, request });
        if (typeof config.permissionDecision === 'function') {
          return config.permissionDecision(jid, request);
        }
        return (
          config.permissionDecision ?? {
            approved: false,
            decidedBy: 'fake-channel',
            reason: `Denied in fake channel: ${request.requestId}`,
          }
        );
      },
      requestUserAnswer: async (jid: string, request: UserQuestionRequest) => {
        userQuestions.push({ jid, request });
        if (typeof config.userAnswer === 'function') {
          return config.userAnswer(jid, request);
        }
        return (
          config.userAnswer ?? {
            requestId: request.requestId,
            answers: {},
            answeredBy: 'fake-channel',
          }
        );
      },
    },
  };
}
