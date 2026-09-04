# ASKFLOOR-1-T2a task-contract grill — round 6

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2a-task-grill.md`); earlier briefs `-r2.md` … `-r5.md`.

Round 5 found three blockers; all folded:
1. The shape classifier returns a DISCRIMINATED result (`read_only_command {executable, targets}` | `file_read {action, targets, requiresTarget}` | `not_read_only {reason}`) and covers only the shell-command and native file-read paths; the MCP read-binding branch (`auto-permission-read-only-gate.ts:159,311`) stays in the gate verbatim; exact result-and-reason parity is required.
2. The status is internal in T2a: the runtime decision-event payload (`permission-classifier.ts:624`) and its exact-payload test (`permission-classifier.test.ts:1689`) are unchanged; Manual Verification step 6 no longer promises a log field.
3. The constitution citation was corrected (no rule claimed that the cited files do not state); the enum and its pure classifier share one small module by design.

Verify: (a) that the discriminated result plus the untouched MCP branch is sufficient to reproduce every existing gate reason string (cite the reasons the tests assert and which variant supplies each value); (b) that no wording anywhere in the contract still promises a published status, a length rule, a veto exemption, `classifierToolInput`, `ipc-parsing.ts`, the handler test or the harness as edited files; (c) consistency across task plan, `plan_contracts`, `acceptance_criteria`, `required_tests` (twelve plain `it` titles), `reviewer_focus`, `write_scope` (15 files), `review_budget` (16/1400). Then re-check items 5–9 of the round-1 brief briefly.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
