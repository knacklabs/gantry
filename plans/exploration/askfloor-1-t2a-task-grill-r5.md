# ASKFLOOR-1-T2a task-contract grill — round 5

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); earlier briefs `-r2.md` … `-r4.md`.

Round 4 found two blockers; both folded by removal:
1. No veto exemption: the attachment row keeps today's completeness, sanitization (`permission-deterministic-rails.ts:125`) and redaction (`:264`) vetoes byte-for-byte; the predicate judges shape only (array of 1..12 non-blank strings) after them. A shortened or redacted id therefore ASKS — the spec's "a malformed id asks" (AF-AC2) and decision 0154 hold unchanged; no spec or decision edit. The handler test and the harness leave the write scope (15 files; budget 16/1400; twelve required tests).
2. Counts and reason corrected.

Verify: (a) that with the vetoes intact the S1 fixture (short host-generated id, no sanitization) still allows in all four lanes at 0 taps; (b) that spec AF-AC2 and decision 0154 are now satisfied verbatim; (c) that nothing in the contract still mentions a length boundary, a veto exemption, `classifierToolInput`, `ipc-parsing.ts`, the handler test or the harness as edited files; (d) consistency across task plan, `plan_contracts`, `acceptance_criteria`, `required_tests` (twelve plain `it` titles), `reviewer_focus`, `write_scope`, `review_budget`. Then re-check items 5–9 of the round-1 brief briefly.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
