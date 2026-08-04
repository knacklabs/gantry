import type {
  RecoveryDispatchPermit,
  RecoveryDispatchPermitInput,
} from './channel-wiring-types.js';

const RECOVERY_DISPATCH_PERMIT_RUNTIME_BRAND = Symbol(
  'gantry.recovery-dispatch-permit',
);

export function sanitizeDeliveryError(err: unknown, provider: string): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  return (
    raw
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[REDACTED_SLACK_TOKEN]')
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
      .slice(0, 500)
      .trim() || `${provider} delivery failed`
  );
}

export function createRecoveryDispatchPermit(
  input: RecoveryDispatchPermitInput,
): RecoveryDispatchPermit {
  const permit: RecoveryDispatchPermitInput = {
    deliveryId: input.deliveryId,
    itemId: input.itemId,
    destinationJid: input.destinationJid,
    canonicalText: input.canonicalText,
    ...(input.threadId ? { threadId: input.threadId } : {}),
  };
  Object.defineProperty(permit, RECOVERY_DISPATCH_PERMIT_RUNTIME_BRAND, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(permit) as unknown as RecoveryDispatchPermit;
}

export function assertRecoveryDispatchPermit(
  permit: RecoveryDispatchPermit,
  input: { jid: string; rawText: string; threadId?: string },
): void {
  if (Reflect.get(permit, RECOVERY_DISPATCH_PERMIT_RUNTIME_BRAND) !== true) {
    throw new Error(
      'Recovery provider send requires a channel-wiring minted recovery dispatch permit.',
    );
  }
  if (permit.destinationJid !== input.jid) {
    throw new Error(
      'Recovery provider send permit destination does not match dispatch destination.',
    );
  }
  if (permit.canonicalText !== input.rawText) {
    throw new Error(
      'Recovery provider send permit canonical text does not match dispatch payload.',
    );
  }
  const expectedThreadId =
    permit.threadId && permit.threadId.trim() ? permit.threadId.trim() : '';
  const actualThreadId =
    input.threadId && input.threadId.trim() ? input.threadId.trim() : '';
  if (expectedThreadId !== actualThreadId) {
    throw new Error(
      'Recovery provider send permit thread scope does not match dispatch thread.',
    );
  }
}
