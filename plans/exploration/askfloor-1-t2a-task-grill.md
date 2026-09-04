# ASKFLOOR-1-T2a task-contract grill — round 1

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2a` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md`.

Inputs of record:
- Approved story plan: `plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md` (§2, T2a line under Task Decomposition, assumptions A-0069/A-0070 in `plans/assumptions.md`).
- Spec: `docs/specs/askfloor-1-judge-actually-judges.md` (AF-AC2 attachment birthright, AF-AC5 status, AF-AC8 S1).
- Decisions: 0043, 0052, 0121, 0154 (amends 0052/0121 for the attachment birthright), 0155.
- T1 is landed on this branch: `apps/core/src/domain/permission-lane.ts`, `apps/core/src/application/permissions/auto-lane-analysis.ts`, the harness `apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts` (`replayPermissionRequest`).
- Lessons: `./forge lesson relevant --files <write_scope>`; in particular lessons 64-74 on rails/analyzer boundaries.

Interrogate, with `path:line` citations:
1. Contract equals plan: each `plan_contracts` statement must be the task plan's Acceptance Criteria verbatim and each must trace to a story AC (AF-AC2, AF-AC5 status half, AF-AC7, AF-AC8 S1). Flag any T2a criterion the story plan assigns elsewhere (T2b: risk table, native Write/Edit; T6: status consumption, inline wiring-missing).
2. Split correctness: can `shared/permission-effect-shape.ts` be genuinely pure given how `auto-permission-read-only-gate.ts:79-105,248-308` computes targets today? Does anything in the shape logic read the filesystem, capability ids or the workspace root? Are the reason strings that existing tests assert reproducible from the composition? Name any caller beyond rails `:149-158` and classifier `:305-314,341-356`.
3. Birthright predicate: is `INPUT_GATED_BIRTHRIGHT_ARGUMENT_PREDICATES` the smallest shape that lets a malformed `attachment_ids` still ASK, given the input-gated evaluation at `permission-deterministic-rails.ts:110-142` and the existing completeness/sanitization check? Does the rails input carry the tool arguments at that point (which field)? Does adding `attachment_open` to the input-gated set change any other lane or the CARDSIMPLE-1 family rail-hit? Confirm the rails are mode-blind.
4. Attachment id shape: confirm the runner schema (`runner/mcp/tools/attachment.ts:38-68`) and host limit (`jobs/ipc-attachment-open-handler.ts:54-59`) match the predicate (1..12, non-blank after trim, ≤ 512 chars). Is there any id format the host rejects that the predicate would allow through to a birthright allow (harmless: host still returns not_found) — state it.
5. Status stamping: is `PermissionClassifierResult` referenced outside `runtime/permission-classifier.ts`? Would a REQUIRED `status` break any typed constructor, mock or IPC codec? Are all branches enumerated (native-risk `:327-330,354-355`, strict `:341-353`, skipped-local `:339-340`, LLM success `:240-246`, failures via `failedResult :642-658`, aborted `:222-227`, input_truncated `:291-300,331-338`)? Is the six-code → unavailable / two-code → skipped mapping consistent with AF-AC5?
6. Native-risk helper: can `:327-330,354-355` move to `runtime/permission-classifier-native-risk.ts` with an unchanged verdict and no duplicated inputs? What does the helper need (tool name, capability ids, gantry risk table)?
7. Required tests: are the eleven ids plain `it` titles (no `it.each` suffix — the stage gate matches the exact JUnit leaf name) and each provable in its named file? Does the S1 leaf need a harness extension for MCP-tool inputs (fixture shape today)?
8. Write scope and budget: every file needed and nothing more (16 files / 1400 lines). Any file outside scope that must change (e.g. a barrel export, architecture map, sandbox copy lists per lesson 'runner-sandbox-copy-lists')?
9. Simplicity: is there a smaller shape that satisfies the ACs? Anything speculative?

Output: `CONTRACT SOUND` or a numbered list of blockers (each: what, where, why it blocks, the minimal fix), then non-blocking notes.
