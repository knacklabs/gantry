export const EXTERNAL_INGRESS_RUNTIME_DISPATCH = Symbol('externalIngressRuntimeDispatch');
export function toPublicSessionQueueIntent(enqueue) {
    return {
        conversationJid: enqueue.conversationJid,
        threadId: enqueue.threadId,
        queueKey: enqueue.queueKey,
    };
}
