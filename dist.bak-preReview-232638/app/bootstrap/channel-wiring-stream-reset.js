export function createChannelWiringStreamReset(input) {
    const resetChannelStreaming = (channel, jid, options) => {
        const sink = input.asStreamingStateSink(channel);
        if (options && 'threadId' in options)
            sink?.resetStreaming(jid, { threadId: options.threadId });
        else
            sink?.resetStreaming(jid);
    };
    return {
        resetStreaming(jid, options) {
            const channel = input.findBoundChannel(jid, options?.providerAccountId);
            if (channel)
                resetChannelStreaming(channel, jid, options);
        },
        asPermissionApprovalSurface(channel) {
            const surface = input.asPermissionApprovalSurface(channel);
            return surface
                ? {
                    ...(surface.dropPendingInteraction
                        ? {
                            dropPendingInteraction: surface.dropPendingInteraction.bind(surface),
                        }
                        : {}),
                    ...(surface.cancelPendingPermission
                        ? {
                            cancelPendingPermission: surface.cancelPendingPermission.bind(surface),
                        }
                        : {}),
                    requestPermissionApproval: (jid, request, onPromptDelivered) => surface.requestPermissionApproval(jid, request, (messageId) => {
                        resetChannelStreaming(channel, jid, {
                            threadId: request.threadId,
                        });
                        onPromptDelivered?.(messageId);
                    }),
                }
                : undefined;
        },
        asUserQuestionSurface(channel) {
            const surface = input.asUserQuestionSurface(channel);
            return surface
                ? {
                    ...(surface.dropPendingInteraction
                        ? {
                            dropPendingInteraction: surface.dropPendingInteraction.bind(surface),
                        }
                        : {}),
                    ...(surface.questionIndexesForDeliveredPrompt
                        ? {
                            questionIndexesForDeliveredPrompt: surface.questionIndexesForDeliveredPrompt.bind(surface),
                        }
                        : {}),
                    ...(surface.cancelPendingQuestion
                        ? {
                            cancelPendingQuestion: surface.cancelPendingQuestion.bind(surface),
                        }
                        : {}),
                    requestUserAnswer: (jid, request, onPromptDelivered) => surface.requestUserAnswer(jid, request, (messageId, questionIndex) => {
                        resetChannelStreaming(channel, jid, {
                            threadId: request.threadId,
                        });
                        onPromptDelivered?.(messageId, questionIndex);
                    }),
                }
                : undefined;
        },
    };
}
