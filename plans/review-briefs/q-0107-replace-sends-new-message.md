# Review brief — lite window Q-0107 (a card replace sends a new message; settled text without the job id)

Facts (live 2026-08-27 02:36Z): the Telegram card path edited the previous message in place for a `replace` revision because `previousMessageId(revision)` was known in-process, so the "fresh card" never appeared (it only did at 18:32Z, right after a restart when the memory was empty). The retire text read "Permission requests for job <id> are settled."

Contract for this diff:
- `sendTelegramJobPermissionCard` edits in place only when the wiring passed `options.replaceMessageId` (edit revisions); otherwise it sends a new message. `settledMessageId` retry short-circuit, lane serialization, bind/record unchanged.
- Retire text: "All permission requests for this job are settled."

Focus: retry idempotency still holds (already-settled revision does not resend); the replace flow order (notice on old message, then new card) still records the new message id. Ignore style.
