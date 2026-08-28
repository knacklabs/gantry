# Review brief — JOBPERM-3-T1 (settled job permission cards disappear like chat: retire outcome + Telegram delete/receipt)

Facts: an approved chat prompt is deleted on Telegram (receipt edit only if the delete fails); the job permission card instead edits itself to "All permission requests for this job are settled." and stays in the group. Owner feedback: the one-time permission cards stick around; they should disappear like chat.

Contract for this diff (AC1 Telegram part, AC2, AC3, AC4):
- The projection records `retireOutcome: 'allowed' | 'expired'` (+ `retiredRows` for expired needs) on a retire revision, derived from need state (cancelled + expiredAt ⇒ expired) — never from text. Per decision 0144 (assumption A-0068) a DENIED row stays a live card row with Reconsider, so a card containing a Deny never retires.
- Allowed retire ⇒ delivered as a delete of the provider message (`deleteMessageId`); on Telegram `deleteMessage` inside the existing per-message lane, `editMessageText` receipt with an empty keyboard if the delete fails. Expired retire ⇒ edit to per-row lines "Expired: <label>", never a delete.
- `retireDelivery.deletedAt` / `receiptMessageId` are recorded on the revision; a retried retire revision no-ops. The durable sanitizer keeps the new revision fields.
- Legacy retire revisions (no outcome) keep today's behaviour. Slack/Discord/Teams unchanged (T2).

Focus: (1) any path that deletes a card with an expired row, or that retires a card while a denied (Reconsider-able) row is still live; (2) a failed delete that retries the delete instead of degrading to the receipt once; (3) a retry after deletedAt that calls the provider again; (4) outcome derivation that misclassifies an expired once row as allowed; (5) the delete racing an in-flight edit outside the lane. Report ONLY behaviour defects. Ignore style.
