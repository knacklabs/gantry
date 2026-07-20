import type {
  InteractionSurface,
  PermissionApprovalRequest,
  StreamingStateSink,
  UserQuestionRequest,
} from '../../domain/types.js';
import type { ChannelStreamResetOptions } from './channel-wiring-types.js';

type PermissionApprovalSurface = Pick<
  InteractionSurface,
  'requestPermissionApproval' | 'dropPendingInteraction'
>;
type UserQuestionSurface = Pick<
  InteractionSurface,
  | 'requestUserAnswer'
  | 'questionIndexesForDeliveredPrompt'
  | 'dropPendingInteraction'
>;

export function createChannelWiringStreamReset<Channel extends object>(input: {
  findBoundChannel: (
    jid: string,
    providerAccountId?: string,
  ) => Channel | undefined;
  asStreamingStateSink: (channel: Channel) => StreamingStateSink | undefined;
  asPermissionApprovalSurface: (
    channel: Channel,
  ) => PermissionApprovalSurface | undefined;
  asUserQuestionSurface: (channel: Channel) => UserQuestionSurface | undefined;
}) {
  const resetChannelStreaming = (
    channel: Channel,
    jid: string,
    options?: Pick<ChannelStreamResetOptions, 'threadId'>,
  ): void => {
    const sink = input.asStreamingStateSink(channel);
    if (options && 'threadId' in options)
      sink?.resetStreaming(jid, { threadId: options.threadId });
    else sink?.resetStreaming(jid);
  };

  return {
    resetStreaming(jid: string, options?: ChannelStreamResetOptions): void {
      const channel = input.findBoundChannel(jid, options?.providerAccountId);
      if (channel) resetChannelStreaming(channel, jid, options);
    },
    asPermissionApprovalSurface(
      channel: Channel,
    ): PermissionApprovalSurface | undefined {
      const surface = input.asPermissionApprovalSurface(channel);
      return surface
        ? {
            ...(surface.dropPendingInteraction
              ? {
                  dropPendingInteraction:
                    surface.dropPendingInteraction.bind(surface),
                }
              : {}),
            requestPermissionApproval: (
              jid: string,
              request: PermissionApprovalRequest,
              onPromptDelivered?: (messageId: string) => void,
            ) =>
              surface.requestPermissionApproval(jid, request, (messageId) => {
                resetChannelStreaming(channel, jid, {
                  threadId: request.threadId,
                });
                onPromptDelivered?.(messageId);
              }),
          }
        : undefined;
    },
    asUserQuestionSurface(channel: Channel): UserQuestionSurface | undefined {
      const surface = input.asUserQuestionSurface(channel);
      return surface
        ? {
            ...(surface.dropPendingInteraction
              ? {
                  dropPendingInteraction:
                    surface.dropPendingInteraction.bind(surface),
                }
              : {}),
            ...(surface.questionIndexesForDeliveredPrompt
              ? {
                  questionIndexesForDeliveredPrompt:
                    surface.questionIndexesForDeliveredPrompt.bind(surface),
                }
              : {}),
            requestUserAnswer: (
              jid: string,
              request: UserQuestionRequest,
              onPromptDelivered?: (
                messageId: string,
                questionIndex?: number,
              ) => void,
            ) =>
              surface.requestUserAnswer(
                jid,
                request,
                (messageId, questionIndex) => {
                  resetChannelStreaming(channel, jid, {
                    threadId: request.threadId,
                  });
                  onPromptDelivered?.(messageId, questionIndex);
                },
              ),
          }
        : undefined;
    },
  };
}
