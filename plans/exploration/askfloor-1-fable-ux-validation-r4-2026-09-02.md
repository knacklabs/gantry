# ASKFLOOR-1 — Fable 5.1 UX validation, plan round 4 (2026-09-02, read-only)

Lane: Claude `claude-fable-5-1` @ high, general-purpose subagent, read-only. Companion lane of record: Codex gpt-5.6-sol @ xhigh (plans/exploration/askfloor-1-plan-grill-r4.md).

Round-3 items: both must-fixes and all three nice-to-haves confirmed present in §5.

## Must-fix (3) — folded
1. Unidentified tapper: line belongs in the card's post-tap slot, not a reply, and must cover No. FOLDED: "Allowed this once. Couldn't tell who tapped, so nothing was remembered." / "Said no this once. Couldn't tell who tapped, so nothing was remembered."; pre-tap "will remember" lines omitted where identity is known not to resolve. Plan §3.
2. Protected artifact entry refused mid-task had no text — the agent would wait for a card that never comes. FOLDED: tool error "Refused: <name> is protected. This is not a permission question — don't retry, tell the owner."; owner line "Couldn't open <name> — it's protected, so I left it alone." Plan AC2.
3. Stale "one narrower alternative" in Scope item (6) and Surface Impact. FOLDED: "one alternative remembering button".

## Nice-to-have — folded
- No-pager line: "Showing the 10 newest. <N> older not shown — forget one here and the next oldest appears."
- Remembered-No denial reason carries what and when: "denied by your remembered No to this exact command (<date>) — /permissions to change".

Verdict: 3 must-fix, all folded.
