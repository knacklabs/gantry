export function asTypingSink(channel) {
    return typeof channel.setTyping === 'function'
        ? channel
        : undefined;
}
export function asStreamingSink(channel) {
    return typeof channel.sendStreamingChunk === 'function'
        ? channel
        : undefined;
}
export function asStreamingStateSink(channel) {
    return typeof channel.resetStreaming === 'function'
        ? channel
        : undefined;
}
export function asProgressSink(channel) {
    return typeof channel.sendProgressUpdate === 'function'
        ? channel
        : undefined;
}
export function asMessageReactionSink(channel) {
    return typeof channel.addReaction === 'function'
        ? channel
        : undefined;
}
export function asGroupDiscoverySource(channel) {
    return typeof channel.syncGroups === 'function'
        ? channel
        : undefined;
}
export function asPermissionApprovalSurface(channel) {
    return typeof channel.requestPermissionApproval === 'function'
        ? channel
        : undefined;
}
export function asUserQuestionSurface(channel) {
    return typeof channel.requestUserAnswer === 'function'
        ? channel
        : undefined;
}
export function asRichInteractionSurface(channel) {
    return typeof channel.renderRichInteraction === 'function'
        ? channel
        : undefined;
}
export function asAgentTodoSurface(channel) {
    return typeof channel.renderAgentTodo === 'function'
        ? channel
        : undefined;
}
