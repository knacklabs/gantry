# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task ASKFLOOR-1-T1

### Plan contracts

- **ASKFLOOR-1-T1-AC1**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md#acceptance-criteria
  - Statement: a classifier low/medium allow is honoured with the rail reason as typed provenance only when `permissionMode` is `auto` and `hostJobId` is absent; `auto_strict`, ask and job lanes keep the veto (explicit tests).
- **ASKFLOOR-1-T1-AC2**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md#acceptance-criteria
  - Statement: `find` with any of `-delete -exec -execdir -ok -okdir -fls -fprint -fprint0 -fprintf` stays refused by the shared parser; the rails' existing meta-executor refusal now carries the canonical typed signal `unsupported_meta_executor` (today it emits `privileged`, `domain/permission-deterministic-rails.ts:41-46,164-171`; verdict unchanged, A-0070) and a read-only `find` makes the analyzer's `readOnlyMetaExecutor` true; `pathCandidates` ignores stderr redirects to `/dev/null` with per-lane tests (assumption A-askfloor-1: an outcome may change only where a non-path stops being treated as a path).
- **ASKFLOOR-1-T1-AC3**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md#acceptance-criteria
  - Statement: the ONE authoritative decision order — pre-coordination route analysis → exact remembered deny [T3b no-op slot] → hard restrictions → reviewed rules → deterministic rails (the single base evaluation) → conditional trusted-root handling (only on the rails' `out_of_trusted_root` ASK; its hypothetical rechecks unchanged) → remembered allows [T3b no-op slot] → classifier-cache read → tail — is the coordinator/tail contract (`permission-decision-coordinator.ts:97-200` enumerated as named stages, pinned by a stage-order test), with the base rail decision computed once and passed to the tail in an immutable typed context.
- **ASKFLOOR-1-T1-AC4**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md#acceptance-criteria
  - Statement: the AF-AC8 replay harness exists as a reusable fixture module; S3 (`2>/dev/null` + read-only `find`) replays at 0 taps in interactive auto; later tasks add fixtures without editing T1's tests.
- **ASKFLOOR-1-T1-AC5**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T1.md#acceptance-criteria
  - Statement: existing unit and Postgres integration suites pass; tsc and check:architecture green.

### Reviewer focus

- Constitution (load-bearing): constitution/README.md -> pnp-coding-standards-modular-monolith.md (types/enums/errors/data-access/thin coordinator in separate files; typed enums over string literals) and 03-modular-monolith-structure.md (application vs runtime vs shared placement). Conformance, not a new layout.
- PermissionLane, RailSignal and RailProvenance are DOMAIN-owned closed types (domain/permission-lane.ts) because domain/types.ts consumes them and domain never imports application (architecture-map.json:79-92); AutoLaneAnalysis is a typed value object whose input/output shapes live in application/permissions/auto-lane-analysis-types.ts; the analyzer is a GENUINELY PURE function (no filesystem, no I/O) whose readOnlyMetaExecutor is the HARD-BOUNDARY predicate: single simple find, no compound/pipeline/redirect/subshell, none of the nine write-capable actions, none of -H/-L/-follow, no indirect or unknown root-source option (-files0-from and the like fail closed), and NO operand — every positional path and every predicate value (-name, -iname, -path, -regex, -newer, -samefile, ...) — matching the conservative pure string predicate isSensitivePathShape (protected capability-path patterns; any segment starting with '.' except the bare '.' so `find .` passes and `..`/`.env` fail; well-known secret file names — a superset of the filesystem-backed checks; TODO(T2a) unify).
- Rails ownership (assumption A-0070): domain/permission-deterministic-rails.ts is a declared T1/T2a shared file; T1 owns ONLY the typed RailSignal value unsupported_meta_executor and its emission for the existing meta-executor refusal (today privileged, :41-46,164-171) with the ASK verdict unchanged — no widening; T2a owns the attachment_open birthright row.
- T1 is IPC-ONLY (assumption A-0069: the coordinator is a declared T1/T3b shared file, T1 limited to the optional analysis/context seam): the IPC helper computes the pre-analysis once in a NEW pre-coordination step before calling the coordinator (:95-170), distinct from the tail's route guard (:184-218) which only consumes the completed context (it alone knows permissionMode, hostJobId and the resolved route mode) and passes it to the coordinator as an OPTIONAL typed input analysis?: AutoLaneAnalysis; the coordinator derives no lane facts, and with an analysis runs ONE base rail evaluation and calls tail(context) with the immutable typed context { analysis, railDecision } replacing today's zero-argument tail; without one (inline-agent-loop-tools.ts:389-395, core-tool-permission-coordinator.ts:61) behaviour is byte-for-byte today's; trusted-root hypothetical rechecks (permission-decision-coordinator.ts:232-268) stay unchanged and are not the base evaluation.
- railProvenance is CANONICAL provenance: an optional typed field on PermissionApprovalDecision (domain/types.ts:298-311 — T1's only addition to that file; T3a's later additions are sequential), included in the signed IPC decision payload (shared/ipc-signing.ts:10-22) and decoded by ALL runner decoders — the generic IPC client (runner/permission-ipc-client.ts:59-75,371-390) and the Anthropic runner decoder (adapters/llm/anthropic-claude-agent/runner/permission-callback.ts:301-387, result type runner/types.ts:119-144); never a host-local side channel.
- The coordinator's authoritative decision order is enumerated as named stages — pre-coordination route analysis, [T3b] exact remembered deny, hard restrictions, reviewed rules, deterministic rails (the single base evaluation), conditional trusted-root handling (only on the rails' out_of_trusted_root ASK; hypothetical rechecks unchanged), [T3b] remembered allows, classifier-cache read, tail — and pinned by a stage-order test; one analysis per IPC permission request, other callers pass none; the harness return type uses PermissionApprovalDecision['decidedBy'], PermissionDecisionSource (domain/types.ts:255) and RailProvenance.
- The IPC tail becomes a thin sequence of five named helpers (route guard, classifier consult, rail-veto/risk merge, cache writeback, prompt/terminal) with explicit typed inputs/outputs; the relaxation lives ONLY in the merge helper, keyed on the base rail decision's typed signal — out_of_trusted_root, or unsupported_meta_executor AND analysis.readOnlyMetaExecutor — and guarded by lane === interactive_auto (never auto_strict, never a hostJobId); every other base ASK (incl. the hard-floor asks for missing/redacted/truncated input, permission-deterministic-rails.ts:127-171,259-276) keeps the veto; a relaxed allow keeps the canonical machine values decidedBy: auto_classifier and source: auto_classifier (domain/permission-decision.ts:69-115) and carries railProvenance: { signal: RailSignal; reason: string } as a separate typed field.
- Shared parser untouched (fail-closed; nine write-capable find actions pinned in the parser's own test file); pathCandidates ignores stderr-to-/dev/null with a per-lane pin; rails/sandbox policy still runs before any grant (0001).
- No domain error type introduced (no named failure contract in T1). DEFERRED with markers: TODO(T2a) typed classifier status; TODO(T3b) memory stages in the coordinator's decision order (documented no-op slots, not speculative abstractions).
- Concerns that must not share a file: the analyzer (application) and the IPC tail (runtime); the AF-AC8 harness is the reusable module apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts exporting `replayPermissionRequest(fixture: TapBudgetFixture): Promise<{ taps: number; decidedBy: PermissionApprovalDecision['decidedBy']; source: PermissionDecisionSource; railProvenance: RailProvenance | null }>` (existing PermissionDecisionSource at domain/types.ts:255, the decided-by union from permission-decision.ts, RailProvenance from domain/permission-lane.ts — concrete types, never unknown) and the `TapBudgetFixture` type (lane inputs, command/tool input, trusted roots, stubbed classifier verdict) so later tasks add fixtures without editing T1's tests; no stringified JSONB equality; runner-spawn sandbox copy sets stay derivable.
- Verification: python3 factory/scripts/verify.py is authoritative; the Postgres lane (npm run test:integration:postgres, GANTRY_TEST_DATABASE_URL exported) is run by the orchestrator as stage evidence, not as a gate command: T1 touches no storage code, and two pre-existing suites (live-waiting-admission, inline-agent-runtime child runs) are red on base 00a6c01f9 / origin/main independent of this story and are tracked as a main quickfix before T3a, whose contract restores the lane as a gate.

## Task ASKFLOOR-1-T2a

### Plan contracts

- **ASKFLOOR-1-T2a-AC1**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md#acceptance-criteria
  - Statement: `attachment_open` with a well-SHAPED `attachment_ids` list — an array of one to twelve strings, each non-blank after trim — is an input-gated birthright in the deterministic rails, so it never asks in ask, auto, auto_strict or autonomous mode (rails are mode-blind; the S1 fixture replays all four lanes at 0 taps). The rails judge SHAPE, on the request's display copy `toolInput` (always present), and the row keeps TODAY's input-gated vetoes byte-for-byte: any sanitization or redaction under the input (`permission-deterministic-rails.ts:125`, `:264`) still asks, exactly as for every other input-gated row — so an id the sanitizer shortened (over 500 characters, `runtime/ipc-tool-input-sanitization.ts:6,64`) or redacted (token-like, `:11,55`) ASKS, which is the spec's "a malformed id asks" (AF-AC2) and decision 0154's wording, unchanged; real attachment ids are short host-generated strings (`message-attachment:…`), so no real id is ever shortened or redacted. No veto exemption, no length rule, no change to `runtime/ipc-parsing.ts`, no dependence on `classifierToolInput`. Origin stays host-validated, unchanged: an id that fails conversation-origin validation (`ipc-attachment-open-handler.ts:43-84`, resolver `attachment-resolver.ts:167-186`) returns the existing not-found line "I couldn't find that attachment in this conversation." — never a card; the handler and its tests are untouched. A missing, empty, more-than-twelve, blank, non-string, shortened or redacted list asks with the rails' existing input-gated ASK outcome.
- **ASKFLOOR-1-T2a-AC2**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md#acceptance-criteria
  - Statement: a pure effect-shape classifier (`shared/permission-effect-shape.ts`) reports the read-only shape, the read/list action, its target paths and `requiresTarget` without any filesystem, capability or workspace input (the action and `requiresTarget` are what capability matching and the existing reason strings key on, `auto-permission-read-only-gate.ts:248,297`); a hard-boundaries evaluator (`shared/permission-hard-boundaries.ts`) owns the capability boundary, realpath containment, protected-path, hidden-segment and secret checks; `evaluateAutoPermissionReadOnlyGate` composes them and every existing gate, rails and classifier test passes unchanged.
- **ASKFLOOR-1-T2a-AC3**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md#acceptance-criteria
  - Statement: `PermissionClassifierResult` carries a REQUIRED closed `status` (`domain/permission-classifier-status.ts`: `answered | unavailable | skipped`): only a successful LLM verdict is `answered`; `llm_unconfigured timeout model_resolution_failure query_error parse_failure validation_failure` are `unavailable`; `aborted`, `input_truncated`, the native-risk, strict-deterministic and skipped-local branches are `skipped`; the native-risk branch lives in the named helper `runtime/permission-classifier-native-risk.ts` with an unchanged verdict; the cache-hit result constructed in `runtime/ipc-permission-classifier-decision.ts` (`:293`, the one constructor outside the classifier file) is stamped `skipped` (a replayed verdict is neither a fresh answer nor an outage).
- **ASKFLOOR-1-T2a-AC4**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md#acceptance-criteria
  - Statement: AF-AC8 S1 — opening an attachment already in the conversation — replays at 0 taps in every lane through T1's harness (`TapBudgetFixture` already carries `toolName` + `toolInput`, `askfloor-tap-budget-harness.ts:11,55`; the harness is NOT edited and is not in scope), added as a fixture without editing T1's leaves.
- **ASKFLOOR-1-T2a-AC5**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md#acceptance-criteria
  - Statement: existing unit and Postgres integration suites pass; tsc and check:architecture green (AF-AC7).

### Reviewer focus

- Constitution (load-bearing): constitution/README.md -> pnp-coding-standards-modular-monolith.md (types/enums in their own files; typed enums over string literals; thin composition) and 03-modular-monolith-structure.md (shared vs domain vs runtime placement). Conformance, not a new layout.
- SPLIT IS A MOVE, NOT A REWRITE: shared/permission-effect-shape.ts is a GENUINELY PURE function (no fs, no capability ids, no workspace root) returning the closed enum PermissionEffectShape (read_only_command | file_read | not_read_only) plus the read/list action, target paths and requiresTarget (grill r1: capability matching and the reason strings at auto-permission-read-only-gate.ts:248,297 key on action + requiresTarget, so both cross the seam); shared/permission-hard-boundaries.ts owns the capability boundary, realpath containment, allProtectedPathMentions, hidden-segment and secret checks VERBATIM from auto-permission-read-only-gate.ts:248-308; the gate keeps its exported signature and result shape and becomes shape -> boundaries. Reason strings identical (existing tests assert them). Both callers (rails :149-158, classifier :305-314,341-356) untouched. Any verdict change in an existing test is a defect, not a fixture to update.
- Rails ownership (assumption A-0070): T2a owns ONLY the attachment_open input-gated birthright row and ONE typed predicate map INPUT_GATED_BIRTHRIGHT_ARGUMENT_PREDICATES consulted by the input-gated evaluation (:110-142) on the request display copy toolInput AFTER today's completeness, sanitization (:125) and redaction (:264) checks — those vetoes stay byte-for-byte for EVERY row including this one (grill r4: an exemption would turn a shortened 513-char id into a tool error and contradict AF-AC2 'a malformed id asks'). The single entry judges SHAPE: an array of 1..12 strings, each non-blank after trim; predicate false -> the EXISTING input-gated ASK outcome; a shortened (over-500-char, runtime/ipc-tool-input-sanitization.ts:6,64) or redacted (token-like, :11,55) id asks via the existing vetoes — real attachment ids are short host-generated strings, none is ever shortened or redacted. No length rule, no veto exemption, no change to runtime/ipc-parsing.ts, no dependence on classifierToolInput. Origin stays host-validated (jobs/ipc-attachment-open-handler.ts:43-84; handler and its tests untouched, not in scope). No other rails row, signal or verdict changes; the unsupported_meta_executor signal (T1) is untouched.
- Rails are mode-blind (no permission-mode input), so 'every mode' holds by construction; the S1 fixture replays the four PermissionLane values through T1's replayPermissionRequest and asserts 0 taps with the birthright decidedBy. The host handler and resolver are NOT touched: origin validation (ipc-attachment-open-handler.ts:43-84; attachment-resolver.ts:167-186) and the not-found copy (attachment-failure.ts:4-5) are already pinned by their own suites.
- Typed status: domain/permission-classifier-status.ts exports the closed enum PermissionClassifierStatus (answered | unavailable | skipped); PermissionClassifierResult.status is REQUIRED and stamped at EVERY branch: failedResult (:642-658) maps llm_unconfigured/timeout/model_resolution_failure/query_error/parse_failure/validation_failure -> unavailable and aborted/input_truncated -> skipped; strict-deterministic (:341-353), skipped-local (:339-340) and native-risk -> skipped; LLM success (:240-246) -> answered; the ONE structural constructor outside the classifier file — the cached-verdict result in runtime/ipc-permission-classifier-decision.ts:293 (T1 file, edited for that constructor only) — stamps skipped. No string literals for status. TODO(T6) marker: status is stamped, not yet consumed (latch + wiring-missing unavailable are T6).
- Native-risk branch (:327-330,354-355) moves to runtime/permission-classifier-native-risk.ts as evaluateNativeRiskBranch(input) -> PermissionClassifierResult | undefined with an UNCHANGED verdict and the same gantryRisk inputs; T2b later passes tool arguments into that helper. The classifier file must not grow a second native-risk path.
- Concerns that must not share a file: shape (pure, shared) vs boundaries (fs-backed, shared) vs the gate (composition); the status enum (domain) vs its stamping (runtime); the native-risk helper (runtime, T2b-owned next) vs the classifier orchestration.
- No domain error type introduced (no named failure contract). Nothing DEFERRED beyond the TODO(T6) consumption marker; T2b owns gantry-tool-risk.ts and the native Write/Edit path judgment — not touched here.
- Verification: python3 factory/scripts/verify.py is authoritative in the gate environment; the Postgres lane (npm run test:integration:postgres, GANTRY_TEST_DATABASE_URL exported) is orchestrator-run stage evidence as for T1 — T2a touches no storage code; two pre-existing suites are red on base/origin/main independent of this story (main quickfix before T3a).

## Task ASKFLOOR-1-T2b

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.

## Task ASKFLOOR-1-T3a

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.

## Task ASKFLOOR-1-T3b

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.

## Task ASKFLOOR-1-T3c

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.

## Task ASKFLOOR-1-T4

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.

## Task ASKFLOOR-1-T5a

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.

## Task ASKFLOOR-1-T5b

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.

## Task ASKFLOOR-1-T6

### Plan contracts

- None declared.

### Reviewer focus

No task-specific reviewer focus declared.
