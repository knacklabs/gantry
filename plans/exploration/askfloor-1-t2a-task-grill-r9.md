# ASKFLOOR-1-T2a task-contract grill — round 9

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); earlier briefs `-r2.md` … `-r8.md`.

Round 8 found two stale citations; both replaced with the ranges round 8 supplied: `stdinOk` at `:131,137`; per-leaf shape logic `:152-246,248-260,348-359,368-469` (not `:79-105`); MCP dispatch `:100-105` and evaluator `:311-345`; the parity-leaf wording now says three.

This is round 9: a citation-only check. Verify that every `auto-permission-read-only-gate.ts` and test line range in the task plan and the decomposition entry matches the current file, and that nothing else changed. Blockers must be defects that would make the implementer build the wrong thing or make an AC unprovable.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
