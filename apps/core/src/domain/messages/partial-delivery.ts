import { sanitizeRetryTailProviderPayload } from './retry-tail-provider-payload.js';

const PARTIAL_MESSAGE_DELIVERY_BRAND = Symbol('gantry.partialMessageDelivery');

type PartialDeliveryRetryTail = {
  canonicalText: string;
  providerPayload?: unknown;
};

type BrandedPartialMessageDeliveryError = Error & {
  [PARTIAL_MESSAGE_DELIVERY_BRAND]: true;
  partialMessageDelivery: true;
  deliveredChunks: number;
  totalChunks: number;
  deliveredParts?: number;
  totalParts?: number;
  provider?: string;
  externalMessageIds?: string[];
  sentPrefix?: string;
  retryTail?: PartialDeliveryRetryTail;
};

type PartialMessageDeliveryMetadata = {
  deliveredParts?: number;
  totalParts?: number;
  provider?: string;
  externalMessageIds?: string[];
  sentPrefix?: string;
  retryTail?: PartialDeliveryRetryTail;
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

export function getPartialMessageDeliveryMetadata(
  err: unknown,
): PartialMessageDeliveryMetadata {
  if (!isPartialMessageDeliveryError(err)) return {};
  const candidate = err as {
    deliveredParts?: unknown;
    totalParts?: unknown;
    provider?: unknown;
    externalMessageIds?: unknown;
    sentPrefix?: unknown;
    retryTail?: unknown;
  };
  const deliveredParts =
    Number.isSafeInteger(candidate.deliveredParts) &&
    (candidate.deliveredParts as number) > 0
      ? (candidate.deliveredParts as number)
      : err.deliveredChunks;
  const totalParts =
    Number.isSafeInteger(candidate.totalParts) &&
    (candidate.totalParts as number) > 0
      ? (candidate.totalParts as number)
      : err.totalChunks;
  const provider =
    typeof candidate.provider === 'string' && candidate.provider.trim()
      ? candidate.provider.trim()
      : undefined;
  const externalMessageIds = Array.isArray(candidate.externalMessageIds)
    ? candidate.externalMessageIds.filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      )
    : undefined;
  const sentPrefix =
    typeof candidate.sentPrefix === 'string' ? candidate.sentPrefix : undefined;
  const retryTail = normalizeRetryTail(candidate.retryTail);
  return {
    deliveredParts,
    totalParts,
    ...(provider !== undefined ? { provider } : {}),
    ...(externalMessageIds && externalMessageIds.length > 0
      ? { externalMessageIds }
      : {}),
    ...(sentPrefix !== undefined ? { sentPrefix } : {}),
    ...(retryTail ? { retryTail } : {}),
  };
}

function normalizeRetryTail(
  value: unknown,
): PartialDeliveryRetryTail | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as {
    canonicalText?: unknown;
    providerPayload?: unknown;
  };
  if (typeof candidate.canonicalText !== 'string') return undefined;
  const canonicalText = candidate.canonicalText.replace(/\r\n/g, '\n');
  if (!canonicalText.trim()) return undefined;
  const providerPayload =
    candidate.providerPayload === undefined
      ? undefined
      : sanitizeRetryTailProviderPayload(candidate.providerPayload);
  return {
    canonicalText,
    ...(providerPayload !== undefined ? { providerPayload } : {}),
  };
}
