# Review brief — lite window Q-0082 (retry-tail sanitizer must keep job-permission card identity)

Facts: Q-0081 made the wiring parser require `jobPermissionCard.callbackKey` (24-hex) and `revision` (safe int ≥ 0). `sanitizeRetryTailProviderPayload` (domain/messages/retry-tail-provider-payload.ts) runs on the real outbox path (outbound-delivery-repository.postgres.ts, setup-permission-prompt-repository, canonical-message-repository-identifiers) and previously kept only operation/providerMessageId/actions — so sanitized card payloads would be rejected as malformed and never delivered. This window is the deploy gate for Q-0081.

Contract for this diff:
- The sanitized card carries `callbackKey` and `revision`, validated to the same shape the wiring accepts; a card missing either is dropped whole (consistent with other malformed cards).
- No other sanitizer behavior changes; views not listed are still stripped.
- The jobperm-edges regression test exercises the payload THROUGH the sanitizer again (it must not bypass it).

Focus: any other producer/consumer of the card payload that would now be dropped (grep `jobPermissionCard`), bound/size checks on the new fields, and that a card with a malformed callbackKey cannot slip through as a card without identity. Ignore style.
