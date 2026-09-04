# ASKFLOOR-1-T2a task-contract grill — round 12

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); rounds 2–11 briefs `-r2.md` … `-r11.md`.

Round 11 (after the owner's "widen" ruling) found two blockers; both folded:
1. Host-valid ids may be token-like, so redaction alone would still ask. The display stays masked; the rails' sanitization veto, for the `attachment_open` row only, disregards redaction-only marks under `attachment_ids.*` (the parser's redacted/truncated split, `ipc-parsing.ts:438`); a truncation mark still asks; any other tool's redacted input still asks (pinned). The false "no generated id is token-like" claim is gone.
2. The length rule is `max(state.maxStringLength, ATTACHMENT_ID_DISPLAY_LIMIT=512)` for `attachment_ids.*`, so the classifier copy (16,000) is untouched; the required sanitizer test covers display 512 intact/unmarked, display 513 shortened/marked, classifier 513 intact. Budget reason corrected to 9 source + 8 test.

Verify with `path:line` citations: (a) that the rails can tell a redaction-only mark from a truncation mark for a given path (which request fields carry `toolInputSanitizedPaths`, and whether redacted vs truncated is distinguishable there — if only the union reaches the rails, state the minimal field the contract must name); (b) that skipping redaction-only marks for one row cannot leak into any other input-gated row or lane; (c) consistency across task plan, `plan_contracts`, `acceptance_criteria`, `required_tests` (thirteen plain `it` titles), `reviewer_focus`, `write_scope` (17), `review_budget` (18/1500). Blockers must be defects that would make the implementer build the wrong thing or make an AC unprovable.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
