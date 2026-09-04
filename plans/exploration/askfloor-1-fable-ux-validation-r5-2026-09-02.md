# ASKFLOOR-1 — Fable 5.1 UX validation, plan round 5 (2026-09-02, read-only, narrow)

Lane: Claude `claude-fable-5-1` @ high, general-purpose subagent, read-only. Companion lane of record: Codex gpt-5.6-sol @ xhigh (plans/exploration/askfloor-1-plan-grill-r5.md).

Round-4 items: all 3 must-fixes and 2 nice-to-haves confirmed present in the plan text.

## Must-fix (2) — folded
1. Silent `file list` filtering would make the agent claim a file does not exist. FOLDED: list appends "(N protected entries hidden — not a permission question, don't retry.)" when N > 0. Plan AC2.
2. Forget `not_found` had no reply. FOLDED: "Nothing to forget — that isn't one of your remembered decisions, or it's already gone. Send /permissions for the current list." (list message untouched). Plan §5.

## Nice-to-have — folded
- When a memory record matched but a hard restriction won: reason line "Your remembered Allow (<scope>) doesn't cover this — <path> is protected, so I always ask." No card teaches the full decision order. Plan §5.

Verdict: 2 must-fix, both folded.
