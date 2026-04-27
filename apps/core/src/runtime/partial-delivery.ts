import { logger } from '../infrastructure/logging/logger.js';

const PARTIAL_MESSAGE_DELIVERY_BRAND = Symbol('myclaw.partialMessageDelivery');

type BrandedPartialMessageDeliveryError = Error & {
  [PARTIAL_MESSAGE_DELIVERY_BRAND]: true;
  partialMessageDelivery: true;
  deliveredChunks: number;
  totalChunks: number;
};

export class PartialMessageDeliveryError
  extends Error
  implements BrandedPartialMessageDeliveryError
{
  readonly [PARTIAL_MESSAGE_DELIVERY_BRAND] = true;
  readonly partialMessageDelivery = true;
  readonly deliveredChunks: number;
  readonly totalChunks: number;
  override readonly cause?: unknown;

  constructor(args: {
    cause: unknown;
    deliveredChunks: number;
    name: string;
    message: string;
    totalChunks: number;
  }) {
    super(args.message);
    this.name = args.name;
    this.cause = args.cause;
    this.deliveredChunks = args.deliveredChunks;
    this.totalChunks = args.totalChunks;
  }
}

export function isPartialMessageDeliveryError(
  err: unknown,
): err is BrandedPartialMessageDeliveryError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { [PARTIAL_MESSAGE_DELIVERY_BRAND]?: unknown })[
      PARTIAL_MESSAGE_DELIVERY_BRAND
    ] === true &&
    (err as { partialMessageDelivery?: unknown }).partialMessageDelivery ===
      true &&
    (err as { deliveredChunks?: unknown }).deliveredChunks !== undefined &&
    Number.isSafeInteger(
      (err as { deliveredChunks: unknown }).deliveredChunks,
    ) &&
    (err as { deliveredChunks: number }).deliveredChunks > 0
  );
}

function summarizePartialMessageDeliveryError(err: unknown): {
  name?: string;
  message?: string;
  deliveredChunks?: number;
  totalChunks?: number;
} {
  if (typeof err !== 'object' || err === null) return {};
  const partial = err as {
    name?: unknown;
    message?: unknown;
    deliveredChunks?: unknown;
    totalChunks?: unknown;
  };
  return {
    ...(typeof partial.name === 'string' ? { name: partial.name } : {}),
    ...(typeof partial.message === 'string'
      ? { message: partial.message }
      : {}),
    ...(typeof partial.deliveredChunks === 'number'
      ? { deliveredChunks: partial.deliveredChunks }
      : {}),
    ...(typeof partial.totalChunks === 'number'
      ? { totalChunks: partial.totalChunks }
      : {}),
  };
}

export async function sendWithPartialDeliveryGuard(
  send: () => Promise<void>,
  context: { group: string },
): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (err) {
    if (!isPartialMessageDeliveryError(err)) throw err;
    logger.warn(
      {
        error: summarizePartialMessageDeliveryError(err),
        group: context.group,
      },
      'Message delivery partially succeeded; marking output delivered to prevent duplicate retry',
    );
    return true;
  }
}
