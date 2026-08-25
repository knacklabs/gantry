# Review brief — lite window Q-0081 (D-0058: card identity on zero-action retire/replace revisions)

Facts: the job-permission card outbox payload already carries `callbackKey`, `revision`, `operation` (job-permission-need-repository.postgres.ts). The wiring's parser kept only actions/operation/providerMessageId, so `retire`/`replace` revisions (zero actions BY DESIGN — they turn the card into a buttonless notice) reached Telegram as a plain `replaceMessageId` edit with no identity. Telegram's in-process settlement (`JobPermissionCardDeliverySettlement`) therefore never learned the card was retired, and a delayed older action revision could edit it back to buttons.

Contract for this diff:
- `MessageSendOptions.jobPermissionCardRevision` (optional `{callbackKey, revision, operation}`) is populated by the wiring for every card revision, including zero-action ones. Missing/invalid `callbackKey`/`revision` in the payload = malformed payload (delivery fails, as for other malformed card payloads).
- Telegram generic replace path, when the identity is present: idempotent (already-settled revision returns the settled id with no provider call), binds the message to the card lane BEFORE the serialized section, serializes on the card lane, and records the revision after the edit so it becomes the newest known revision — an older action revision is then rejected by `settledMessageId`.
- Without the option, the generic replace path is unchanged. Cross-restart idempotency remains owned by the reconciler's per-revision delivery outcomes (do not report restart replay).
- For `replace`, the preliminary notice edit of the OLD message carries NO identity BY DESIGN; only the new card's send settles the replace revision (older revisions then resolve to the new message via settledMessageId).
- The action-bearing card path is unchanged.

Focus: key scoping (chat-scoped callbackKey must match the card path's scoping), the replacement-notice send in the wiring (uses the same identity?), `operation: 'replace'` semantics (new message after a retire) vs `retire`, and any way a zero-action edit could record a revision for the wrong message. Ignore style.
