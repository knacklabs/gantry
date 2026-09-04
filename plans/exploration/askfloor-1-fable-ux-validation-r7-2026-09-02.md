# ASKFLOOR-1 — Fable 5.1 UX validation, plan round 7 (2026-09-02, read-only, attachment birthright)

Lane: Claude `claude-fable-5-1` @ high, general-purpose subagent, read-only. Companion lane of record: Codex gpt-5.6-sol @ xhigh (plans/exploration/askfloor-1-plan-grill-r7.md).

Round-6 items: must-fix and nice-to-have confirmed in §5.

## Attachment birthright in every mode (owner ruling)
- Silent read in ask mode is not surprising — the owner just sent the file. No first-time explainer (status clutter rule). Folded as a plan note.
- Failed host validation (id from another chat): reuse the existing line "I couldn't find that attachment in this conversation." (`attachment-failure.ts:4`); the handler's forbidden reject text stays agent-facing.
- Must-fix (1) — FOLDED: AC2 said "failing any condition asks"; a bad id must never become a card. Now: malformed id asks; failed origin validation → not-found line, never a card.

Verdict: 1 must-fix, folded.
