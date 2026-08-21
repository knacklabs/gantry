# SCHED-4B-1 RE-ARCHITECTURE (supersedes the bespoke durable protocol)

Owner decision: settle setup-pause approvals through the EXISTING durable
interaction machinery instead of the hand-rolled protocol grown across review
rounds. The diff should SHRINK. If the durable machinery cannot re-run the
setup fence on restart recovery without building new infrastructure, STOP and
report — do not grow a parallel protocol again.

## Remove (these reimplement what the durable handler already owns)
- the in-memory Promise.race settlement in settleSetupPausePermissionPrompt
- the delivery lease: undelivered_leased / delivery-lease stamping + reclaim
- the claim-token protocol (claimJobSetupApproval / renew / release /
  approval_claim_expires_at) IF the durable recovery path makes it redundant
- the pending_undelivered status and the reclaim-on-lease-expiry branches
- the initialNotificationMark barrier + reopen-ordering handoff

## Route through existing infra
- Settle via runDurablePermissionInteraction (durable-interaction-handler.ts):
  begin dedups the durable row (concurrent readiness checks -> one prompt);
  prompt = deps.requestPermissionApproval with onPromptDelivered; the STANDARD
  PermissionPersistenceBackend applies the grant AND calls
  recheckSetupPausedJobsAfterCapabilityUpdate — the same chain the request_access
  chat flow uses (pending-interaction-permission-recovery.ts).
- Restart recovery: recoverDurablePermissionDecision
  (pending-interaction-permission-recovery-orchestrator.ts) must cover
  setup-pause requests so a decision arriving after a restart is applied +
  rechecked without an in-memory settler.

## Keep exactly one setup-specific guard
- Before the grant is applied — on BOTH the live settle and the recovery path —
  re-validate the job is still setup-paused with the SAME fingerprint (and not
  deleted); reject the grant otherwise. Inject this as a hook the durable
  machinery runs in both paths (afterDecision / recovery hook). This single
  re-validation replaces the whole hand-rolled fence/claim/lease.

## Keep (already correct)
- host-only request construction from the job's STORED requirement
- grantable-blocker mapping (semantic capability / browser / mappable tool rule;
  mcp_server/credential/config -> instruction card only)
- Allow-for-future/Deny only on setup-pause prompts (no allow_once)
- full setup story, provider parity (incl. Discord 5-button rows), silent /
  notified guards, best-effort deletion retirement, divergent-route handling

## A-0048 shared-path ceiling
The shared durable row has a provider prompt binding but no canonical delivery
lease. A process crash after durable record creation and before provider
delivery can therefore leave an undelivered pending interaction that shared
recovery does not reissue. Setup-pause containment keeps this strand-safe:
`already_pending` sends the instruction card to the approver route and marks
the fingerprint notified from that delivered card. The owner still has the
manual `request_access` / manage-access path. Fully closing the prompt-button
gap requires a canonical durable-lease reissue design for the shared permission
path, including `request_access`, and is deliberately deferred.
