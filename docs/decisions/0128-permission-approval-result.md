---
status: proposed
confirmed_by: ""
date: 2026-08-12
stories: [JOBFLOW-1]
---

# Permission Approval Result [JOBFLOW-1]

## Context

Every channel adapter (telegram, slack incl. its outer wrapper, teams,
discord) and the shared requester convert "the prompt could not be
delivered" into {approved:false} — indistinguishable from a human
denial. Every interactive consumer (admin registration, skill install/
review, profile updates, runtime admin, classifier prompts, core tools,
capability amendments) currently treats that as the human saying no.

## Decision

The approval surface returns a typed union:
{kind:'decision', decision: PermissionApprovalDecision} |
{kind:'delivery_failure', code: target_missing | surface_unsupported |
provider_failed, retryable, delivered:'no'|'unknown', userMessage}.
delivered:'no' only on LOCAL preflight proof (target resolution/
validation, disabled surface); once the provider API call is invoked,
every exception or timeout is delivered:'unknown' and is NEVER retried
(a retry could duplicate a visible prompt). The durable interaction
handler branches on the failure variant BEFORE decision side effects and
settlement — the row stays pending; delivered prompts keep their
no-response-timeout semantics unchanged. Every consumer branches
explicitly: infrastructure failure surfaces as "couldn't deliver the
prompt", never as a denial. The dormant promotion-offer lane
(offer/markOffered/lastOfferedAt) is deleted narrowly; the counter/read
path is untouched.

## Consequences

- One atomic cutover across all four adapters and all listed consumers
  (enumerated in the contract appendix) — the type change makes silent
  erasure impossible to reintroduce.
- Interactive behavior for successfully delivered prompts is unchanged.
- Rejected (do not re-propose): changing the requester's result globally
  to "unresolved" (breaks decision-only consumers); a per-lane fix
  (four other call sites share the bug); retrying delivered:'unknown'.
Full contracts: plans/JOBFLOW-contract-appendix.md (S3, typed result).
