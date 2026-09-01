# CARDSIMPLE-1 requirements grill — cold read (read-only, no edits)

You did not author this spec. Read it cold, as an adversary. Target: the CONFIRMED spec `docs/specs/cardsimple-1-one-permission-surface.md`, held against the CURRENT repository state and `constitution/`.

The spec was validated four days of work ago against the same tree by four read-only passes; since then the only merges are PR #460/#462 (CARDFIX-1 pause-card actions + host provenance lane — the spec explicitly supersedes parts of it), PR #461 (SKILLS-WEB-1 web UI), and PR #464 (harness re-vendor + this spec's own ledger). Your job is the REQUIREMENTS question, not implementation detail:

1. Is every Behaviour bullet still true to the current code's reality (no drift from the merges above)? Cite file:line only where something moved.
2. Are the four acceptance criteria individually testable, and together sufficient for the stated Why (one surface, Allow settles the future, late taps get receipts)?
3. Is anything in the spec ambiguous enough that two reasonable implementers would build different things? Name the sentence.
4. Does the spec contradict `constitution/` or any active decision it does not explicitly amend?
5. Is the Not-in-scope list complete — is there adjacent behavior a reader would wrongly assume this story changes?

Output: a numbered findings list — claim, evidence, severity (blocker | design-gap | nit), smallest spec amendment. If nothing needs to change before planning proceeds, say "CLEAN" explicitly. No edits anywhere.
