# CARDSIMPLE-1 simplicity pass — T2 only (read-only, no edits, keep reading TIGHT)

You are a lazy senior engineer. Read ONLY the T2 (one canonical card) section of `plans/active/CARDSIMPLE-1-one-permission-surface-family-wide-grants.md` and answer fast. Question: the minimum T2 that still delivers AC1 (one actionable surface per blocked need; no prose message; no reconciler loop; no second surface).

A prior pass already found one cut, verify and extend it: the plan's NEW "setup-origin delivery state" contradicts decision 0124, which explicitly rejected "a separate delivery state machine" — the EXISTING setup prompt already has fingerprint identity, durable request snapshot, bounded delivery generations, ambiguous/exhausted outcomes and re-raise reconciliation (`docs/decisions/0124-bounded-durable-card-delivery.md`, `apps/core/src/application/jobs/setup-pause-permission-prompt.ts`, `app/bootstrap/setup-pause-permission-wiring.ts`). Should the merge REUSE 0124's item/generation state as the delivery authority instead?

Also interrogate:
1. Is the new fingerprint-keyed `attachSetupNeed` ingress necessary, or can the existing setup-prompt raise path simply project INTO the canonical card (the card as the render/action surface, the existing prompt machinery as the delivery/identity authority)?
2. Does the full action-shape × blocker-type row mapping need building now, or do the shapes that actually occur (tool + credential + instruction) suffice with the rest deferred?
3. Is moving `notified_fingerprint` ownership required, or does keeping the existing marker semantics with the card as the delivered artifact avoid the atomic-ownership-move risk entirely?
4. Which migration steps (bootstrap re-raise loop, partial recovery, grant guards) shrink if the existing prompt machinery is kept as the authority?

Do NOT weaken: one-surface guarantee, no-prose, 0144 Reconsider, 0134 row semantics, approver-route-only.

Output: numbered CUT / DEFER(with when) / KEEP items + an 8-line minimum-T2 sketch. Verdict: "SIMPLE ENOUGH" or "OVER-BUILT: N cuts". No edits.
