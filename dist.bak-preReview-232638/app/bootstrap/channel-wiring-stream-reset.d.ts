import type { InteractionSurface, StreamingStateSink } from '../../domain/types.js';
import type { ChannelStreamResetOptions } from './channel-wiring-types.js';
type PermissionApprovalSurface = Pick<InteractionSurface, 'requestPermissionApproval' | 'dropPendingInteraction' | 'cancelPendingPermission'>;
type UserQuestionSurface = Pick<InteractionSurface, 'requestUserAnswer' | 'questionIndexesForDeliveredPrompt' | 'dropPendingInteraction' | 'cancelPendingQuestion'>;
export declare function createChannelWiringStreamReset<Channel extends object>(input: {
    findBoundChannel: (jid: string, providerAccountId?: string) => Channel | undefined;
    asStreamingStateSink: (channel: Channel) => StreamingStateSink | undefined;
    asPermissionApprovalSurface: (channel: Channel) => PermissionApprovalSurface | undefined;
    asUserQuestionSurface: (channel: Channel) => UserQuestionSurface | undefined;
}): {
    resetStreaming(jid: string, options?: ChannelStreamResetOptions): void;
    asPermissionApprovalSurface(channel: Channel): PermissionApprovalSurface | undefined;
    asUserQuestionSurface(channel: Channel): UserQuestionSurface | undefined;
};
export {};
