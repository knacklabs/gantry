# ASKFLOOR-1-T2a seam exploration (read-only)

Read-only cold-read exploration, no file edits, no writes. Report facts with `path:line` citations only. Do not propose designs beyond what is asked.

Context: story plan `plans/active/ASKFLOOR-1-the-judge-actually-judges-context-aware-first-asks-in-auto-mode.md` (§2 and the T2a line under Task Decomposition), decisions 0154 and 0155, spec `docs/specs/askfloor-1-judge-actually-judges.md` (AF-AC2 attachment birthright, AF-AC5 status). T1 is merged on this branch (lane enums in `apps/core/src/domain/permission-lane.ts`, analyzer `apps/core/src/application/permissions/auto-lane-analysis.ts`, rails signal `unsupported_meta_executor`).

Answer each item with citations:

1. `apps/core/src/shared/auto-permission-read-only-gate.ts`: list every exported function and its callers (grep the repo). For the region around lines 248-308: which function couples the verb/argument read-only shape classification with capability checks, realpath containment and secret checks? Name the exact inputs it reads (tool name, arguments, capability ids, trusted roots, cwd) and the outputs. Which callers need ONLY the shape verdict versus the full gate?
2. Protected capability-path predicates in `apps/core/src/shared/tool-execution-protected-paths.ts` (around :40-102): exported names and signatures; which of them the read-only gate calls today.
3. `apps/core/src/domain/permission-deterministic-rails.ts` birthright table (around :53-103): the exact data shape of a birthright row (tool name match, argument predicate?, mode applicability), how rows are evaluated, and whether an INPUT-GATED row (allow only when the argument has a well-formed opaque attachment id) can be expressed with the current shape or needs a predicate field. Cite the rails test file and the block that pins the birthright table.
4. `attachment_open`: the runner tool registration (name, input schema, the id field name and its format — how an opaque id looks, what "well-formed" means), and the host handler `apps/core/src/jobs/ipc-attachment-open-handler.ts` (around :42-84): the server-side origin validation and the exact error text for an id not in the conversation; the runner-side not-found line in `attachment-failure.ts:4`.
5. `apps/core/src/runtime/permission-classifier.ts`: the result type (around :58-66) with every `failureCode` value; every branch that produces a result (native-risk, strict-deterministic, skipped-local, LLM success, LLM failure, aborted, input_truncated) with line ranges, and which branches currently lack a failureCode. Cite `runtime/permission-classifier.test.ts` blocks that pin failure handling.
6. The inline live consult in `apps/core/src/bootstrap/inline-agent-loop-tools.ts` (around :399-445): where it skips consultation silently when wiring is missing; and the IPC helper's consult helper after T1 (`apps/core/src/runtime/ipc-permission-classifier-decision.ts`, the classifier-consult helper) — where a typed status would be read.
7. Existing unit test files for: the read-only gate, the protected paths predicates, the rails birthright table, the attachment handler, the classifier. Give paths and the describe titles.
8. Any other caller that would break if the read-only gate is split into two shared modules (shape classifier without containment; containment helper).

Output: a numbered list mirroring the items above, facts only.
