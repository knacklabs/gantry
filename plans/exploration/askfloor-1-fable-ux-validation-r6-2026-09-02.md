# ASKFLOOR-1 — Fable 5.1 UX validation, plan round 6 (2026-09-02, read-only, batch card only)

Lane: Claude `claude-fable-5-1` @ high, general-purpose subagent, read-only. Companion lane of record: Codex gpt-5.6-sol @ xhigh (plans/exploration/askfloor-1-plan-grill-r6.md).

Round-5 items: both must-fixes and the nice-to-have confirmed present.

## Batch card
- Once-only semantics confirmed against the code: Allow all → allow_once, Deny all → cancel, Review each → fan-out via `dispatchSingle` (`permission-approval-requester.ts:387`) to normal single-ask cards with the standard "will remember" copy. No "will remember" line on the batch card — correct.
- Must-fix (1) — FOLDED: the line's slot was unnamed and the batch card has two renderers (`formatPermissionBatchPromptText`, `buildPermissionBatchPromptParts` with `contextLines: []`); native cards would silently drop it. Pinned: after the rows, before the wait line, in both, covered by the four-provider parity test.
- Nice-to-have — FOLDED: "Allow all and Deny all are once-only. Tap Review each to decide one at a time — those cards can remember."

Verdict: 1 must-fix, folded.
