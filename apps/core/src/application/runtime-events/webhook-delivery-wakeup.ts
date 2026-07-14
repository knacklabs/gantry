const listeners = new Set<() => void>();

export function notifyWebhookDeliveryReady(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeWebhookDeliveryReady(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
