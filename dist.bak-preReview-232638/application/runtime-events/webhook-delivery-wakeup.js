const listeners = new Set();
export function notifyWebhookDeliveryReady() {
    for (const listener of [...listeners])
        listener();
}
export function subscribeWebhookDeliveryReady(listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
