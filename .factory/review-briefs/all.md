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

### Lessons in force

Recorded lessons that apply to this task's paths. A finding that contradicts one is not a defect unless it shows the lesson itself is wrong; say so explicitly instead of re-raising it.

- [medium] schema storage: Runtime state, jobs, control events, and memory use Postgres as the production storage model; schema or repository changes need repository tests and architecture/docs updates when contracts shift.
- [high] architecture boundaries: Keep provider-specific and channel-specific behavior behind adapters; domain and application code should depend on stable product concepts and ports, not SDK payloads or runtime wiring.
- [high] permission safety: Risky tool execution must pass through deterministic permission evaluation and sandbox policy before any provider callback or runner grants access.
- [high] capability runtime projection: Selected local_cli capabilities must project credential directories as readable SDK additionalDirectories while keeping them denyWrite, and scheduled parentless SandboxNetworkAccess suppression must be bound to a reviewed command template plus declared host rather than flat host hints.
- [high] runner memory IPC: When memory IPC auth scope includes per-run reviewer authority, every runner boundary must forward memoryReviewerIsControlApprover into the Gantry MCP server env; otherwise approver runs sign memory_search and continuity_summary requests with a different scope than runtime verification.
- [high] runner-sandbox-copy-lists: Runner-spawning tests (agent-runner-ipc, ipc-mcp-stdio) sandbox the runner by COPYING source files; hand-enumerated lists silently break when a new module becomes runner-reachable (every test then burns its ~19s IPC timeout). Fixed 2026-07-22 by recursive cpSync of the whole shared/ tree. If a runner-spawn test suite suddenly times out uniformly, check the sandbox copy set FIRST; never reintroduce per-file enumeration of a derivable file set.
- [low] prettier-before-factory-verify: Run the focused Prettier check after adding or reshaping TypeScript tests so the deterministic structural gate does not rediscover formatting drift.
- [medium] unit-lane-nontermination: The full npm run test:unit lane can finish the LIVE-1 surfaces and then remain silent without a Vitest summary in this checkout; do not call it green without the exit code, and preserve focused lane evidence separately.
- [medium] managed-sandbox-junit-test-id: Managed command policy can reject required VITEST_JUNIT/FORGE_TEST_ID commands when the exact testcase identifier contains a literal greater-than separator. Report the wrapper lane as blocked and do not call it passing.
- [low] managed-test-id-redirection-policy: Managed command policy can refuse the required FORGE_TEST_ID when its exact test name contains a greater-than character; report the policy refusal separately from focused test evidence.
- [medium] nonterminating-vitest-blast-radius: A jobs or runner directory-wide Vitest invocation can remain live without a summary or exit code in the managed environment; terminate it after bounded polling and report it as unverified, not green.
- [medium] vitest-emfile-watcher: A focused Vitest selector can complete its test but still exit 1 when the macOS watcher hits EMFILE; treat this as blocked verification and rerun with the canonical wrapper or a watcher-safe environment.
- [high] JSONB persistence vs in-memory fakes: Postgres JSONB normalizes object key order and drops undefined; any equality check against persisted state (JSON.stringify ===) silently fails in prod while structuredClone-based fakes keep it green. Compare with util.isDeepStrictEqual and make repository fakes persist through a JSONB-faithful round trip (see test/unit/application/jsonb-round-trip.ts).
- [low] managed-env-prefix-policy: Managed execution can reject a required test when an inline environment assignment is the command prefix, reporting that the shell wrapper hides prefix inspection; invoke the same command through env so the executable prefix is visible, and report any remaining refusal separately.
- [low] managed-env-prefixed-test-policy: Managed command policy can refuse required Vitest commands when a leading environment assignment obscures the inspected prefix; preserve the refusal and run an equivalent direct Vitest JUnit command separately.
- [high] find analyzer must be fail-closed in every argument position: readOnlyMetaExecutor may only be true when EVERY find argument is recognised: reject any unknown or indirect root option (e.g. -Z, -files0-from) regardless of position, not just the first argument — autoreview found 'find -P -Z roots.txt' slipping through and enabling an interactive-auto classifier allow over the hard rail. Parse the full option/operand grammar or reject unrecognised options anywhere; add the ordering case to the parameterized safety test.
- [high] rail-ASK outcomes must run every named decision stage before the tail: In the coordinator a base rail ASK (including the reviewed-rule-allows-but-rail-asks branch) must still flow through conditional trusted-root handling and the classifier-cache read before invoking tail(context); an early return there ignores learned trusted roots for reviewed-rule requests and skips cached verdicts for the newly relaxable out_of_trusted_root / read-only find cases (autoreview P2 at permission-decision-coordinator.ts:172). Cover the rail-ASK path in the stage-order test.
- [high] find analyzer must reject path-qualified executables: readOnlyMetaExecutor may only be true for the bare command word find (no path component, no ./find, /tmp/find, or any basename match) — autoreview r2 P1: the analyzer accepted any executable whose basename is find, letting an untrusted path-qualified binary be relaxed. Reject path-qualified or otherwise qualified executables before any option parsing; add the case to the parameterized safety test.
- [high] every non-relaxable rail ASK stays a classifier veto: In the IPC merge helper treat EVERY base rail ASK as requiring approval and exempt only the two relaxable conditions (out_of_trusted_root; unsupported_meta_executor AND readOnlyMetaExecutor) via relaxesRailVeto — autoreview r2 P1: railRequiresApproval was false for soft ASKs such as RailSignal.Destructive, so a classifier allow reached the auto-allow path without rail provenance. Add a negative leaf per non-relaxable signal.
- [medium] cached classifier allows flow through the rail merge, not around it: For a relaxable rail ASK the coordinator must pass an existing cached classifier allow through the typed tail/merge path (same lane guard and rail provenance) instead of discarding it with '&& !railDecision' and re-consulting the classifier — autoreview r2 P2 at permission-decision-coordinator.ts:219: a valid cached verdict was ignored, causing fresh consults and prompts when the classifier is unavailable.
- [medium] trusted-root stage never invokes the tail itself: resolveTrustedRootStage must only prepare the trusted-root prompt/learning state and continue through the remembered-allow and classifier-cache stages to the single tail invocation, with any persistent-root writeback after that decision — autoreview r2 P2 at permission-decision-coordinator.ts:320: with a candidate root but no learned grant it invoked the tail directly, skipping the authoritative order and forcing a live classifier call despite a cached verdict. Pin it in the stage-order test.
- [high] soft rail ASKs keep today's classifier eligibility; only hard-floor asks veto: CORRECTS lesson 66: T1 must not turn every non-relaxable rail ASK into a classifier veto. Today a non-hard-floor ASK (e.g. RailSignal.Destructive for an ordinary single-file delete) is classifier-eligible and cacheable — pinned by the existing rails test 'keeps an ordinary single-file delete eligible for classifier allow and caching' — and the T1 contract keeps that byte-for-byte. Veto = hard-floor asks (missing/redacted/truncated input, protected/secret paths, capability gates) exactly as before; relaxation = the two signals; everything else = today's behaviour, no new veto.
- [high] cached classifier allows are consumed only in classifier-eligible lanes: Gate cached-verdict consumption and any auto-allow from it on the lane: a classifier allow cached while in auto must never be reused after switching to permissionMode ask (ask mode has no classifier authority), and auto_strict keeps its veto behaviour — autoreview r3 P1: with every analyzed rail ASK now reaching the cache stage, an ordinary single-file delete cached in auto was executed as auto_classifier in ask mode without a prompt. Add an ask-lane cached-allow negative leaf.
- [high] canonicalize bare dot segments before protected capability-path matching: isSensitivePathShape must remove or canonicalize internal bare '.' segments before matching the protected capability-path patterns (artifacts/./skills and agents/<id>/./skills resolve to the protected directories) while still allowing the standalone 'find .' operand — autoreview r3 P1: 'find artifacts/./skills' was classified read-only and relaxed the parser ASK instead of keeping the protected-path hard floor. Add dot-segment cases (internal '.', './', trailing '/.') to the parameterized safety test.
- [high] coordinator cache stage under a rail ASK: Under a rail ASK the classifier-verdict cache may be read ONLY when the signal is one of the two overridable ones (out_of_trusted_root, unsupported_meta_executor) AND the lane is interactive auto, because only the tail merge can consume it there. Every other rail ASK (destructive, secret, escape, family-rule hit) must skip the cache read entirely, exactly as before this story: ipc-interaction-handler.test.ts pins that a destructive ASK never calls getClassifierVerdict while the intact command is still written back. Run the full unit suite (verify.py), not only the nine T1 suites, before ending a run.
- [high] read-only find must fail closed on unquoted pathname expansion: readOnlyMetaExecutor may be true only when every find token is exactly what find will receive. The tokenizer drops quoting, so scan the RAW command text: any '*', '?' or '[' outside single/double quotes and not backslash-escaped is unquoted pathname expansion and fails closed (autoreview r5 P1: with a file named -delete in cwd, 'find . ?delete' expands to 'find . -delete' after the relaxation). Quoted globs stay read-only ('find . -name "*.ts"'); unquoted ones keep today's ask. With this the class of bash word rewriting is closed: parameter/command/arithmetic expansion, backticks and braces are rejected by the parser, tilde can only become a path, quote removal is handled by the tokenizer, word splitting only follows rejected expansions. Add parameterized cases: ?delete, *delete, [-]delete, \*delete (escaped, allowed), quoted '*.ts' (allowed), unquoted -name *.ts (refused).

## Task ASKFLOOR-1-T2a

### Plan contracts

- **ASKFLOOR-1-T2a-AC1**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md#acceptance-criteria
  - Statement: `attachment_open` whose request input is COMPLETE, UNSANITIZED, UNREDACTED and well-SHAPED — `attachment_ids` an array of one to twelve strings, each non-blank after trim — is an input-gated birthright in the deterministic rails, so such a request never asks in ask, auto, auto_strict or autonomous mode (rails are mode-blind; the S1 fixture replays all four lanes at 0 taps). The rails judge SHAPE on the request's display copy `toolInput` (always present) AFTER today's completeness, sanitization (`permission-deterministic-rails.ts:125`) and redaction (`:264`) checks, which stay byte-for-byte for every input-gated row including this one; therefore an id the sanitizer shortened (over 500 characters, `runtime/ipc-tool-input-sanitization.ts:6,64`) or redacted (token-like, `:11,55`) ASKS — an accepted limit consistent with the spec's "a malformed id asks" (AF-AC2) and decision 0154: today's generated ids are short (`message-attachment:…`, `canonical-message-attachments.postgres.ts:54-80`) and no bound is claimed for future formats; if a host-valid id ever trips sanitization, that is a separately scoped sanitization change, not a rails exemption. No veto exemption, no length rule, no change to `runtime/ipc-parsing.ts`, no dependence on `classifierToolInput`. Origin stays host-validated, unchanged: an id that fails conversation-origin validation (`ipc-attachment-open-handler.ts:43-84`, resolver `attachment-resolver.ts:167-186`) returns the existing not-found line "I couldn't find that attachment in this conversation." — never a card; the handler and its tests are untouched. A missing, empty, more-than-twelve, blank, non-string, shortened or redacted list asks with the rails' existing input-gated ASK outcome.
- **ASKFLOOR-1-T2a-AC2**
  - Source: .factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2a.md#acceptance-criteria
  - Statement: a pure effect-shape classifier (`shared/permission-effect-shape.ts`) classifies ONE PARSED LEAF at a time with a pure context `classifyPermissionEffectShape(leaf, { stdinOk })` — `stdinOk` is the compound/pipeline fact the gate already derives per leaf (standalone leaves get `false`, compound leaves `true`, `auto-permission-read-only-gate.ts:131,137`) and is what `requiresTarget` depends on, since `BashCommandLeaf` carries no compound context (`bash-command-parser.ts:14`) — covering the verb/argument shape logic INCLUDING `grepFileArgs` (`:429-468`, which moves into the shape module) and the native file-read shape, returning a DISCRIMINATED result `{ kind: read_only_command, executable, targets } | { kind: file_read, action, targets, requiresTarget } | { kind: not_read_only, reason }`, computed without any filesystem, capability or workspace input; the gate RETAINS, verbatim: compound orchestration over the ordered leaves (`:120-140`), the whole-command raw guards at `:115-122` and `:149-150` (protected-path and secret MENTIONS scanned over the command text before any target is discarded, e.g. `grep settings.yaml README.md` is refused on the mention), and the MCP read-binding branch (dispatch `:100-105`, evaluator `:311-345`); a hard-boundaries evaluator (`shared/permission-hard-boundaries.ts`) owns the TARGET-level checks from the file-read path (`:261-308`: capability boundary, realpath containment, protected-path, hidden-segment and secret on each target; the file-read SHAPE part `:248-260` and its pure path predicate `isProvablyWorkspacePath` `:361-366` belong to the shape module, so ownership is disjoint); `evaluateAutoPermissionReadOnlyGate` composes leaf shape → target boundaries inside its unchanged orchestration with EXACT result-and-reason parity, pinned by the existing suite plus explicit parity leaves in the composition test for (i) a standalone `cat` versus the same leaf inside `cat | wc -l`, (ii) a compound command, and (iii) a non-target protected mention (`grep settings.yaml README.md`) — the existing `:342-346` case is the workspace-root one and is not the mention proof.
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

- Constitution (load-bearing): constitution/03-modular-monolith-structure.md (modules with clear boundaries, strict separation of concerns, no circular dependencies, predictable ownership) and pnp-coding-standards-modular-monolith.md. DELIBERATE RECORDED DEVIATION: the new modules are named like their siblings in apps/core/src/shared (kebab-case.ts, no dotted role suffix, e.g. permission-trusted-paths.ts) instead of the constitution's suffix table (pnp-coding-standards-modular-monolith.md:22-54, which would want a lone .helper.ts) — the repo deviates from that table repo-wide and consistency with siblings wins; no other rule is claimed from those files.
- SPLIT IS A MOVE, NOT A REWRITE: shared/permission-effect-shape.ts is ONE small module holding the closed enum PermissionEffectShape and the GENUINELY PURE per-LEAF classifyPermissionEffectShape(leaf, { stdinOk }) (no fs, no capability ids, no workspace root; stdinOk is the compound/pipeline fact the orchestration already derives per leaf — standalone false, compound true, auto-permission-read-only-gate.ts:131,137 — and requiresTarget is derived from it INSIDE the classifier because BashCommandLeaf carries no compound context, bash-command-parser.ts:14) returning a DISCRIMINATED result — { kind: read_only_command, executable, targets } | { kind: file_read, action, targets, requiresTarget } | { kind: not_read_only, reason }; it takes over the per-leaf shape logic (:152-246,248-260,348-359,361-366,368-469 — includes grepFileArgs :429-468 and the pure isProvablyWorkspacePath :361-366; NOT :79-105, which is capability normalization and top-level dispatch and stays in the gate). NOT MOVED, verbatim in the gate: compound orchestration over ordered leaves (:120-140), the whole-command raw guards at :115-122 and :149-150 (protected-path/secret MENTIONS over the command text; grep settings.yaml README.md is refused on the mention), and the MCP read-binding branch (dispatch :100-105, evaluator :311-345). shared/permission-hard-boundaries.ts owns the per-TARGET checks from the file-read path VERBATIM (:261-308 only — capability boundary, realpath containment, protected-path, hidden-segment, secret; disjoint from the shape module's :248-260,361-366). The gate keeps its exported signature and result; inside its unchanged orchestration each leaf becomes shape -> boundaries with EXACT result-and-reason parity; three explicit parity leaves in the composition test: standalone cat vs the same leaf in cat | wc -l; a compound command; a non-target protected mention (the existing :342-346 case is the workspace-root one, not the mention proof). Both callers (rails :149-158, classifier :305-314,341-356) untouched. Any verdict or reason change in an existing test is a defect, not a fixture to update.
- Rails ownership (assumption A-0070): T2a owns ONLY the attachment_open input-gated birthright row and ONE typed predicate map INPUT_GATED_BIRTHRIGHT_ARGUMENT_PREDICATES consulted by the input-gated evaluation (:110-142) on the request display copy toolInput AFTER today's completeness, sanitization (:125) and redaction (:264) checks — those vetoes stay byte-for-byte for EVERY row including this one (grill r4: an exemption would turn a shortened 513-char id into a tool error and contradict AF-AC2 'a malformed id asks'). The single entry judges SHAPE: an array of 1..12 strings, each non-blank after trim; predicate false -> the EXISTING input-gated ASK outcome; a shortened (over-500-char, runtime/ipc-tool-input-sanitization.ts:6,64) or redacted (token-like, :11,55) id asks via the existing vetoes — real attachment ids are short host-generated strings, none is ever shortened or redacted. No length rule, no veto exemption, no change to runtime/ipc-parsing.ts, no dependence on classifierToolInput. Origin stays host-validated (jobs/ipc-attachment-open-handler.ts:43-84; handler and its tests untouched, not in scope). No other rails row, signal or verdict changes; the unsupported_meta_executor signal (T1) is untouched.
- Rails are mode-blind (no permission-mode input), so 'every mode' holds by construction; the S1 fixture replays the four PermissionLane values through T1's replayPermissionRequest and asserts 0 taps with the birthright decidedBy. The host handler and resolver are NOT touched: origin validation (ipc-attachment-open-handler.ts:43-84; attachment-resolver.ts:167-186) and the not-found copy (attachment-failure.ts:4-5) are already pinned by their own suites.
- Typed status: domain/permission-classifier-status.ts exports the closed enum PermissionClassifierStatus (answered | unavailable | skipped); PermissionClassifierResult.status is REQUIRED and stamped at EVERY branch: failedResult (:642-658) maps llm_unconfigured/timeout/model_resolution_failure/query_error/parse_failure/validation_failure -> unavailable and aborted/input_truncated -> skipped; strict-deterministic (:341-353), skipped-local (:339-340) and native-risk -> skipped; LLM success (:240-246) -> answered; the ONE structural constructor outside the classifier file — the cached-verdict result in runtime/ipc-permission-classifier-decision.ts:293 (T1 file, edited for that constructor only) — stamps skipped. No string literals for status. The status is INTERNAL in T2a: the runtime decision-event payload (:624) and its exact-payload test (permission-classifier.test.ts:1689) are unchanged; T6 publishes it. TODO(T6) marker: status is stamped, not yet consumed (latch + wiring-missing unavailable are T6).
- Native-risk branch (:327-330,354-355) moves to runtime/permission-classifier-native-risk.ts as evaluateNativeRiskBranch(input) -> PermissionClassifierResult | undefined with an UNCHANGED verdict and the same gantryRisk inputs; T2b later passes tool arguments into that helper. The classifier file must not grow a second native-risk path.
- Concerns that must not share a file: shape (pure, shared) vs boundaries (fs-backed, shared) vs the gate (composition); the status enum (domain) vs its stamping (runtime); the native-risk helper (runtime, T2b-owned next) vs the classifier orchestration.
- No domain error type introduced (no named failure contract). Nothing DEFERRED beyond the TODO(T6) consumption marker; T2b owns gantry-tool-risk.ts and the native Write/Edit path judgment — not touched here.
- Verification: python3 factory/scripts/verify.py is authoritative in the gate environment; the Postgres lane (npm run test:integration:postgres, GANTRY_TEST_DATABASE_URL exported) is orchestrator-run stage evidence as for T1 — T2a touches no storage code; two pre-existing suites are red on base/origin/main independent of this story (main quickfix before T3a).

### Lessons in force

Recorded lessons that apply to this task's paths. A finding that contradicts one is not a defect unless it shows the lesson itself is wrong; say so explicitly instead of re-raising it.

- [medium] schema storage: Runtime state, jobs, control events, and memory use Postgres as the production storage model; schema or repository changes need repository tests and architecture/docs updates when contracts shift.
- [high] architecture boundaries: Keep provider-specific and channel-specific behavior behind adapters; domain and application code should depend on stable product concepts and ports, not SDK payloads or runtime wiring.
- [high] permission safety: Risky tool execution must pass through deterministic permission evaluation and sandbox policy before any provider callback or runner grants access.
- [high] runner-sandbox-copy-lists: Runner-spawning tests (agent-runner-ipc, ipc-mcp-stdio) sandbox the runner by COPYING source files; hand-enumerated lists silently break when a new module becomes runner-reachable (every test then burns its ~19s IPC timeout). Fixed 2026-07-22 by recursive cpSync of the whole shared/ tree. If a runner-spawn test suite suddenly times out uniformly, check the sandbox copy set FIRST; never reintroduce per-file enumeration of a derivable file set.
- [low] prettier-before-factory-verify: Run the focused Prettier check after adding or reshaping TypeScript tests so the deterministic structural gate does not rediscover formatting drift.
- [medium] unit-lane-nontermination: The full npm run test:unit lane can finish the LIVE-1 surfaces and then remain silent without a Vitest summary in this checkout; do not call it green without the exit code, and preserve focused lane evidence separately.
- [medium] managed-sandbox-junit-test-id: Managed command policy can reject required VITEST_JUNIT/FORGE_TEST_ID commands when the exact testcase identifier contains a literal greater-than separator. Report the wrapper lane as blocked and do not call it passing.
- [low] managed-test-id-redirection-policy: Managed command policy can refuse the required FORGE_TEST_ID when its exact test name contains a greater-than character; report the policy refusal separately from focused test evidence.
- [medium] nonterminating-vitest-blast-radius: A jobs or runner directory-wide Vitest invocation can remain live without a summary or exit code in the managed environment; terminate it after bounded polling and report it as unverified, not green.
- [medium] vitest-emfile-watcher: A focused Vitest selector can complete its test but still exit 1 when the macOS watcher hits EMFILE; treat this as blocked verification and rerun with the canonical wrapper or a watcher-safe environment.
- [high] JSONB persistence vs in-memory fakes: Postgres JSONB normalizes object key order and drops undefined; any equality check against persisted state (JSON.stringify ===) silently fails in prod while structuredClone-based fakes keep it green. Compare with util.isDeepStrictEqual and make repository fakes persist through a JSONB-faithful round trip (see test/unit/application/jsonb-round-trip.ts).
- [low] managed-env-prefix-policy: Managed execution can reject a required test when an inline environment assignment is the command prefix, reporting that the shell wrapper hides prefix inspection; invoke the same command through env so the executable prefix is visible, and report any remaining refusal separately.
- [high] every non-relaxable rail ASK stays a classifier veto: In the IPC merge helper treat EVERY base rail ASK as requiring approval and exempt only the two relaxable conditions (out_of_trusted_root; unsupported_meta_executor AND readOnlyMetaExecutor) via relaxesRailVeto — autoreview r2 P1: railRequiresApproval was false for soft ASKs such as RailSignal.Destructive, so a classifier allow reached the auto-allow path without rail provenance. Add a negative leaf per non-relaxable signal.
- [high] soft rail ASKs keep today's classifier eligibility; only hard-floor asks veto: CORRECTS lesson 66: T1 must not turn every non-relaxable rail ASK into a classifier veto. Today a non-hard-floor ASK (e.g. RailSignal.Destructive for an ordinary single-file delete) is classifier-eligible and cacheable — pinned by the existing rails test 'keeps an ordinary single-file delete eligible for classifier allow and caching' — and the T1 contract keeps that byte-for-byte. Veto = hard-floor asks (missing/redacted/truncated input, protected/secret paths, capability gates) exactly as before; relaxation = the two signals; everything else = today's behaviour, no new veto.
- [high] cached classifier allows are consumed only in classifier-eligible lanes: Gate cached-verdict consumption and any auto-allow from it on the lane: a classifier allow cached while in auto must never be reused after switching to permissionMode ask (ask mode has no classifier authority), and auto_strict keeps its veto behaviour — autoreview r3 P1: with every analyzed rail ASK now reaching the cache stage, an ordinary single-file delete cached in auto was executed as auto_classifier in ask mode without a prompt. Add an ask-lane cached-allow negative leaf.

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
