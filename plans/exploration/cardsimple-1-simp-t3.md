# CARDSIMPLE-1 simplicity pass — T3 only (read-only, no edits, keep reading TIGHT)

You are a lazy senior engineer. Read ONLY the T3 (late tap) section of `plans/active/CARDSIMPLE-1-one-permission-surface-family-wide-grants.md` and answer fast. Question: the minimum T3 that still delivers AC3 (late Allow ⇒ decision recorded + one receipt + Run now; late Deny ⇒ receipt + Reconsider, no Run now; zero trigger fanout; nothing auto-runs).

Interrogate for over-build:
1. Is the three-state live|late|stale matrix per needId+askingEpoch simpler as: "stale card revision ⇒ ignore (already handled today by revision checks); otherwise late iff no live waiter lease"? Does mixed-batch rejection protect anything real in a single-operator deployment?
2. Does the "typed durable post-settlement receipt outcome + idempotent receipt marker + deterministic trigger identity {jobId,needId,askingEpoch,decision}" trio collapse into ONE idempotency story — e.g. reuse the CARDFIX-1 pattern exactly (fingerprint-derived deterministic trigger id, create-first refusal, pg-boss send-id dedupe at `enqueueSchedulerTriggerDelivery`) with the receipt keyed by the same id?
3. Is the fanout deletion (rerun barriers) already sufficient to fix the observed 3-stuck-triggers bug, with the receipt/Run-now polish being severable?
4. Which of the six write-scope files (durability port/effects/wiring, both JSONB validators, run-now) are truly forced by the minimum version?

Do NOT weaken: zero-fanout, no auto-run, late Deny keeps Reconsider (0144), exactly-once receipt user experience.

Output: numbered CUT / DEFER(with when) / KEEP items + a 6-line minimum-T3 sketch. Verdict: "SIMPLE ENOUGH" or "OVER-BUILT: N cuts". No edits.
