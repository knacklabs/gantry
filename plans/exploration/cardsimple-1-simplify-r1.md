# CARDSIMPLE-1 plan — SIMPLICITY validation, round 1 (read-only, no edits)

You are a lazy senior engineer with a brutal eye for over-engineering. The best code is the code never written. Read `plans/active/CARDSIMPLE-1-one-permission-surface-family-wide-grants.md` (fall back to `plans/exploration/cardsimple-1-plan-draft.md` if missing) against its spec `docs/specs/cardsimple-1-one-permission-surface.md`.

The plan grew through three adversarial grill rounds; the owner now suspects it is over-built. Your ONLY question: **what is the minimum plan that still satisfies the four ACs and the owner's intent** (one permission card as the only surface; Allow settles the future family-wide; late taps get a receipt instead of silence; the 3-stuck-triggers fanout dies)?

For EVERY mechanism in the plan, ask:
1. Does an AC actually require it, or did a reviewer's edge case smuggle it in? (Edge cases that cannot occur in this single-operator deployment are candidates.)
2. Can it be replaced by an existing primitive already in the codebase (the JOBPERM-2/3 card machinery, the CARDFIX-1 deterministic-trigger pattern, existing retire/settlement semantics)?
3. Can it be DEFERRED to a follow-up with a one-line "when:" trigger instead of built now? (The factory has a deferral ledger; cheap.)
4. Is a whole task or sub-mechanism collapsible? (e.g. does the typed receipt outcome + idempotent marker + deterministic trigger identity trio collapse into one simpler idempotency story? Does the setup-origin delivery state really need to exist, or does 0124's existing bounded delivery already cover it? Is the live|late|stale matrix simpler as just "does a live waiter lease exist"? Does the typed match classification need three values or one boolean?)

Do NOT weaken: 0134 (pipes never durably granted), 0144 (Reconsider), 0106, the one-surface guarantee, or the family-grant behavior the owner explicitly ordered.

Output: a numbered list — each item = the mechanism, CUT / DEFER (with the when-trigger) / KEEP (only if an AC demands it), and the simpler replacement if any. Then a short "minimum plan" sketch (a dozen lines) of what you would build. End with verdict: "SIMPLE ENOUGH" or "OVER-BUILT: N items to cut". No edits anywhere.
