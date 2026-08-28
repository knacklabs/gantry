READ-ONLY exploration for JOBPERM-3-T2 (do not edit files). Context: T1 (commit f8cc8c4bd) made a retired job-permission card revision carry retireOutcome ('allowed' | 'expired'), retiredRows, retireDelivery; the wiring (apps/core/src/app/bootstrap/job-permission-wiring-setup.ts) delivers retire/allowed with MessageSendOptions.deleteMessageId and expired with replaceMessageId + "Expired: <label>" lines; Telegram implements delete in apps/core/src/channels/telegram/job-permission-card-delivery.ts (retireTelegramJobPermissionCard: delete inside the per-message lane, editMessageText receipt fallback, idempotent via retireDelivery.deletedAt/receiptMessageId/deleteFailedAt).
T2 must give Slack and Discord the same delete-with-receipt-fallback, and Teams a receipt card (verify whether Teams can delete bot activities) — mirroring how each provider already settles CHAT permission prompts.
Report, with file:line citations:
1. For Slack, Discord and Teams: where job-permission card revisions are delivered today (send/edit/replace/retire), which function handles replaceMessageId, and where deleteMessageId would be handled.
2. How each provider's CHAT permission prompt is settled today (delete vs edit; which API call; any lane/serialization) — the behaviour T2 must mirror.
3. Whether each provider's delivery path already reports jobPermissionCardRetireDelivery in its MessageDeliveryResult and how the receipt/delete outcome should be recorded (compare Telegram).
4. The existing unit test files per provider for job-permission card delivery and the fixtures they use.
5. Risks: idempotent retry, message id availability (Slack ts, Discord message id, Teams activity id), rate limits, and any provider that cannot delete bot messages.
Return a structured report; no code changes.
