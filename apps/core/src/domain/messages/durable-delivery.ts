const AMBIGUOUS_DURABLE_DELIVERY_BRAND = Symbol(
  'myclaw.ambiguousDurableDelivery',
);

type BrandedAmbiguousDurableDeliveryError = Error & {
  [AMBIGUOUS_DURABLE_DELIVERY_BRAND]: true;
  ambiguousDurableDelivery: true;
  provider: string;
  conversationJid: string;
  externalMessageId?: string;
  externalMessageIds?: string[];
};

export class AmbiguousDurableDeliveryError
  extends Error
  implements BrandedAmbiguousDurableDeliveryError
{
  readonly [AMBIGUOUS_DURABLE_DELIVERY_BRAND] = true;
  readonly ambiguousDurableDelivery = true;
  readonly provider: string;
  readonly conversationJid: string;
  readonly externalMessageId?: string;
  readonly externalMessageIds?: string[];
  override readonly cause?: unknown;

  constructor(input: {
    provider: string;
    conversationJid: string;
    message?: string;
    cause: unknown;
    externalMessageId?: string;
    externalMessageIds?: string[];
  }) {
    super(
      input.message ??
        'Provider send succeeded but durable sent-status persistence failed. Delivery visibility is ambiguous and cannot be blindly retried.',
    );
    this.name = 'AmbiguousDurableDeliveryError';
    this.provider = input.provider;
    this.conversationJid = input.conversationJid;
    this.cause = input.cause;
    this.externalMessageId = input.externalMessageId;
    this.externalMessageIds = input.externalMessageIds;
  }
}

export function isAmbiguousDurableDeliveryError(
  err: unknown,
): err is BrandedAmbiguousDurableDeliveryError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { [AMBIGUOUS_DURABLE_DELIVERY_BRAND]?: unknown })[
      AMBIGUOUS_DURABLE_DELIVERY_BRAND
    ] === true &&
    (err as { ambiguousDurableDelivery?: unknown }).ambiguousDurableDelivery ===
      true
  );
}
