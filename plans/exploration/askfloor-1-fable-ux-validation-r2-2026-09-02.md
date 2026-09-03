# ASKFLOOR-1 — Fable 5.1 UX validation, plan round 2 (2026-09-02, read-only)

Lane: Claude `claude-fable-5-1` @ high, general-purpose subagent, read-only. Companion lane of record: Codex gpt-5.6-sol @ xhigh (plans/exploration/askfloor-1-plan-grill-r2.md).

Prior round: all 9 items confirmed folded.

## Must-fix (6) and how each was folded
1. A learned **No** defaulted to the same scope as Allow (`kind` for reads) — a "No to every read, anywhere" would silently fail later reads with no card. FOLDED: deny always learns `exact`; post-tap copy "I'll keep saying no to this exact action. Change it with /permissions."; agent-visible denial reason "denied by your remembered decision — /permissions to change". Plan §3 + AC3 + decision 0154.
2. Two remembering buttons on CARDSIMPLE-1 family cards ([Allow] + "Allow for future" + promotion hint). FOLDED as the recommended shape pending the owner's word (owner round 2): one remembering button per card — the family button takes the single alternative slot, promotion hint suppressed. Plan §5.
3. Path-only write wording must say "any future content". FOLDED: pre-tap "Allow will remember: writing to <path> — any future content, no more asking for this file."; post-tap "Remembered: writes to <path> (any content). …". Plan §5.
4. `/permissions` rows lacked the outcome and used "you" (cards are identity-scoped, 0118). FOLDED: "Allow · read-only reads · anywhere · 2 Sep · Ravi" / "No · rm -rf build · exact · 2 Sep · Ravi". Plan §5.
5. Stale Forget tap undefined. FOLDED: buttons bound to record id; second tap replies "Already forgotten."; list edited in place where the provider allows. Plan §5.
6. Rails-bump re-ask said "since you last allowed this" — false for an invalidated No. FOLDED: "…since you last decided this." Plan §5 + AC3.

## Nice-to-have (folded)
- "Only in this folder" → "Allow only in this folder"; order Allow / alternative / Just this once / No.
- Destructive cards: lone once-button reads "Allow once".
- "also used by job X" → "covers job <name>", max two names then "+N jobs".
- Outage notice sent before the first offline card; no "back online" message.

## Tap counts
S1 0, S2 ≤1, S3 0, S4 1 per delete, S5 0 / re-cards after Forget, S6 ≤1 per uncovered read — plan claims hold.

Verdict: 6 must-fix, all folded (item 2 awaiting owner confirmation).
