# ASKFLOOR-1 — Fable 5.1 UX validation, plan round 8 (2026-09-03, read-only, /permissions all + forget id)

Lane: Claude `claude-fable-5-1` @ high, general-purpose subagent, read-only. Companion lane of record: Codex gpt-5.6-sol @ xhigh (plans/exploration/askfloor-1-plan-grill-r8.md).

Round-7 must-fix: confirmed in AF-AC2.

## Folded
- Count line split into two sentences (count, then the two commands).
- `/permissions all` row: "a3f9 · Allow · read-only reads · anywhere · 2 Sep · Ravi" — same nouns as button rows, short id last; short id = first 4 hex chars of the record id (text uuid-shaped primary key), extended to 6 on collision.
- Must-fix (1): `revokeById` takes a full id, so a prefix must resolve against this person's active records to exactly one match; ambiguous → "That id matches more than one — send /permissions all and use the longer id."; replies identical to the [Forget] button flow.

Verdict: 1 must-fix, folded.
