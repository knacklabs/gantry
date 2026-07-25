---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-25
---

# Durable Cancellation Invariant

## Context
PERM-4 (#292) removed the five-minute timebox on interactive permission prompts and
user questions. Before that, a stale prompt self-resolved when its timeout fired;
afterwards an aborted or crashed turn leaves its prompt actionable indefinitely, and a
late approval could persist a permission rule for a tool call that no longer exists.
PERM-4 therefore introduced a durable cancellation lane, which became the largest source
of late review findings — roughly ten across eight closeout cycles — because it is a
distributed-systems problem rather than a defect list. Issue #293 exists to state the
model once and audit every path against it.

A read-only validation pass over the CANCEL-1 plan confirmed the remaining defects and
**refuted** the originally proposed fix (see Decision), which is why the mechanism below
is stated explicitly rather than left to implementation.

## Decision
**A signed cancellation is consumed only when it is definitively settled, or when its
retention TTL expires — never on a transient failure, never on a restart, and never
before the decision it must veto.**

Corollaries that follow, and that implementations must satisfy:

- **Host-owned durable state is the source of truth.** After the first authenticated
  parse, the cancellation is moved atomically into a single host-owned record holding the
  parsed cancellation, its digest, attempt count and expiry; retries operate on that
  record and do **not** re-reserve the inbound replay marker. Detachable two-file state
  (envelope + `.retry` sidecar) is not permitted: losing the sidecar caused the re-parse
  to hit an already-consumed replay marker and the cancellation to be archived, i.e. lost.
  If such a record ever lives in a runner-writable location it MUST be host-authenticated;
  a version marker alone would be an auth bypass.
- **Replay protection is not relaxed to achieve durability.** Making an `EEXIST`
  reservation succeed for an identical envelope digest was considered and REJECTED: it
  would make replaying a captured signed envelope valid, and two workers racing the same
  envelope would both succeed, breaking the single-winner contract. Duplicate inbound
  envelopes continue to be rejected.
- **Non-terminal outcomes retain.** `queued`, `not_found`, and a throwing handler are all
  retryable; only `settled` (or an equivalent terminal settlement) consumes. `not_found`
  is explicitly NOT terminal — at the channel layer it means only that no channel-local
  alias currently exists; `already_decided` is the terminal result.
- **Exactly one retry owner per cancellation.** A cancellation must not be driven by both
  an in-process timer and the durable directory, which can race.
- **Authenticated lifetime equals the retention window.** One constant drives the signer,
  the verifier's extended window, and the directory's retention arithmetic, honoured only
  for the matching `authPurpose`.
- **Claim/ack lifecycle.** While a request is UNCLAIMED the runner's wait is bounded by the
  ingestion TTL, so an unclaimed request cannot strand a runner. Once the host has CLAIMED
  it, the runner waits indefinitely and the cancellation lane is the only way to withdraw
  the delivered prompt.
- **Exhausted retention is archived and observable, never silent** — on both expiry paths
  (retention/mtime expiry and authentication-freshness expiry), because the residual risk
  is precisely that a cancelled turn's prompt remains approvable. Archives must be
  lane-qualified, uniquely named and bounded; today they share a flat directory with no TTL
  and a name that omits the lane, so permission and question archives can overwrite.

## Consequences
- The two lane directories may be collapsed into one lane-parameterised implementation
  configured by request lane, response lane, in-flight kind, parser, handler and log label.
  Retry state must remain per-lane (or pruning must be lane-scoped), otherwise one lane's
  pass would prune the other's state. The existing `describe.each` suite covering both lanes
  is the regression guard and must stay green unmodified; if it cannot, the merge is not
  behaviour-neutral and is abandoned.
- Observability requires an interaction-level runtime event (not the permission-only
  cancellation event) and threading the already-declared `publishRuntimeEvent` dependency
  into both IPC pump call sites; publication is best-effort. Adding an event type
  regenerates the OpenAPI enum, so contract/SDK generation is in scope.
- Accepted residual risk: the host acts only on cancellations it receives; one lost beyond
  retention leaves a stale prompt approvable. That case becomes auditable rather than
  invisible. Defensive withdrawal of the prompt itself was considered and deliberately not
  adopted (2026-07-25), to avoid acting on a cancellation the host never managed to deliver.
- Accepted upgrade risk, recorded because review raised it four times: a cancellation already
  retained in the previous envelope-plus-`.retry` format at the moment of upgrade has had its
  replay id reserved, so the new code re-parses it, replay validation rejects it, and it is
  archived instead of delivered. No migration is provided — this repo does not carry
  backward-compatibility burden during active development, the predecessor format shipped only
  in PERM-4 (#292), and retained cancellations are a transient state. The failure is bounded and
  auditable, not silent: the catch path logs the error and archives the envelope under the
  lane-qualified name, so the outcome collapses into the residual risk above — one stale prompt,
  discoverable. Writing a migration would mean parsing a runner-writable sidecar to reconstruct
  authenticated state, which is the trust boundary this decision exists to protect.
- See [[permission-holistic-redesign]] for the ladder this protects.
