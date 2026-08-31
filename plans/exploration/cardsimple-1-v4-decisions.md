# CARDSIMPLE-1 validation pass 4 of 4 — decision contradictions (read-only, no edits)

Scope ONLY this question; keep reading tight. Check the draft spec `docs/specs/cardsimple-1-one-permission-surface.md` for contradictions with recorded decisions and the just-shipped work:

- 0134: compound/piped commands never durably granted for autonomous runs (spec claims to keep this — verify its Allow-once wording actually preserves the invariant end to end).
- 0144: denied rows keep a live card with one-tap Reconsider (does "one surface, minimal messages" conflict?).
- 0106: runs and triggers never mutate job definitions.
- JOBPERM-2 grant shapes (rule | once) — is "family rule" a new grant shape or a widening of `rule`?
- CARDFIX-1 PRs #460/#462: neutral pause-card actions (`scheduler_retry_ask`/`scheduler_pause_job`) and the host-lane mutation provenance fix — does the spec silently supersede or orphan any of it?

Read the decision records under docs/decisions/ (use `./forge decision list --active` output if helpful) and the relevant code only as needed to judge each contradiction. Output: numbered findings — claim, evidence (decision id + file:line), severity (blocker | design-gap | nit), smallest spec amendment. End with: is the spec implementable as written?
