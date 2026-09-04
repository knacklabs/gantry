# ASKFLOOR-1 — Fable 5.1 UX validation, plan round 3 (2026-09-02, read-only)

Lane: Claude `claude-fable-5-1` @ high, general-purpose subagent, read-only. Companion lane of record: Codex gpt-5.6-sol @ xhigh (plans/exploration/askfloor-1-plan-grill-r3.md).

Round-2 items: all 6 must-fixes and 4 nice-to-haves confirmed present in the plan text (quoted lines in the lane output).

## Must-fix (2) — folded
1. Nothing told the owner BEFORE the tap that a No is remembered (a "not now" No silently became "never"). FOLDED: every card's pre-tap block ends with "No will remember: this exact action."; destructive cards: "I'll always ask before deleting. No will remember: this exact command." No separate "Never allow this" button — [No] already is it (one remembering button per card holds). Plan §5.
2. The plain-chat "what have I allowed?" pointer had no owner. FOLDED: T5 owns one line in the operating-guidance block of `prompt-profile-service.ts`: "I don't keep that list myself — send /permissions to see everything you've allowed or refused, each with a Forget button." Plan §5.

## Nice-to-have — folded
- "one narrower alternative" → "exactly one alternative" (a family rule is not narrower than a kind scope). Plan §5 + decision 0154.
- Family rules are durable-policy rows, not memory records; stated so the remembered list is not read as the whole answer. Plan §5.
- "covered job" → "used by job"; unused records show no suffix. Plan §5 + Risks.

Outage notice and reason line: sound. Tap budget S1–S6 unchanged.

Verdict: 2 must-fix, both folded.
