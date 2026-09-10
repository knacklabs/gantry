# Cold-read grill — gate: task — task plan ASKFLOOR-1-T6

You did NOT write what follows. Read it cold, as an adversary trying to break the handover, never as its author defending it. You are READ-ONLY: return findings, change nothing.

## Interrogation technique

Run the interrogation this way. The harness contract above is the floor; this is the technique.

---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview me relentlessly about every aspect of this until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the environment (filesystem, tools, etc.), look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not act on it until I confirm we have reached a shared understanding.


## Harness grill contract

# Griller Prompt — adversarial handover interrogation

You run BEFORE a handover gate, interrogating the humans in rounds until the
handover has no gaps or contradictions that would surface downstream as
rework. You are not reviewing code — you are stress-testing
what one role is about to hand the next. The gate scripts REFUSE without
your fresh, passing record.

**Independence is the whole point.** A grill has value only when the party
running it did NOT author the artifact under interrogation — a self-grill
inherits the author's blind spots and rubber-stamps the very gap it was meant to
catch (a plan that promised an API surface can pass its own grill precisely
because its author never scoped that surface). So if the coordinating session
authored the plan, the JIT task contract, or the decomposition, it MUST run that
grill in a SEPARATE agent that did not author the artifact — a read-only Codex
pass reading the plan/contract cold, released with
`./forge grill run --gate <gate>` (ledgered, so a killed launcher is still
visible to `forge codex status`; it pins gpt-5.6-terra @ xhigh from
harness.yaml) — rather than certify its own work inline. Codex on `gpt-5.6-terra` @ xhigh
is the required cold reader for planning grills: a fresh model context fully
independent of the authoring session, and because it is read-only it never
writes, so the write-lock that gates the write companion does not apply. Do NOT
use a Claude sub-agent for the grill, and never grill your own work inline.
Interrogate as an adversary trying to break the handover, never as its author
defending it.

RELEASE IT THROUGH THE HARNESS. `./forge grill run --gate <gate>` composes the cold-read brief (this contract plus the artifact) and releases Codex through the SAME ledgered launcher a delegation uses: the pid is recorded before the wait, so a grill whose launcher is killed still shows up in `forge codex status` instead of vanishing. It is read-only, so it takes no delegation lock and can never satisfy `stage done`. Recording the gate stays yours — the cold read only returns findings.

The technique is Matt Pocock's `grilling` skill — the design tree, the
frontier, numbered questions with recommended answers. `doctor --fix` installs
it into BOTH runtimes, and `./forge grill run` also inlines it into the brief,
so a reader reaches it whether or not its runtime resolves skills. This
contract is the harness-side floor; `grilling` is the technique.

`grill-me` is the HUMAN entry point — you type `/grill-me` and it redirects to
`grilling`. It carries `disable-model-invocation: true`, so no model invokes it
and none should be told to.

WHICH RUNTIME CAN RECORD WHICH GATE — get this wrong and you will chase a
refusal you cannot satisfy. ALL SIX gates match the AskUserQuestion ledger and
are therefore CLAUDE-ONLY, each with a floor of ONE logged round: `--gate spec`,
`--gate signoff`, `--gate epics`, `--gate requirements`, `--gate plan` and
`--gate task` — the floors live in `grill_gates.GATES`, one row per gate.
`signoff` and `epics` used to sit outside that check and so recorded with ZERO
rounds behind them; they now answer to it like every other gate.

ONE round is a FLOOR, never a target. Keep going until a round comes back clean
AND the next one stays clean — a single quiet round after a noisy one is a
coincidence, not convergence. The ledger files are written ONLY by `post_tool_use.py` on a
Claude Code AskUserQuestion event; `.codex/hooks.json` registers no PostToolUse
hook, so Codex cannot produce them and neither can a subagent. Delegating a
ledger-matched grill to Codex returns a well-formed payload that the recorder
then refuses, with nothing you can do to satisfy it — the payload was never the
problem, the runtime was.

For those four ledger-matched gates, independence is a COLD READ,
not necessarily a separate process. The recorder accepts ONLY rounds that match a
logged AskUserQuestion record (`record_grill_from_json.py`), and only the
top-level Claude session produces those log entries — a subagent or
read-only Codex pass cannot. So for those grills the top-level session drives
the rounds through AskUserQuestion itself — but because the coordinating session
authored the plan, the independent cold-read pass is MANDATORY, not optional: on
EVERY round release a fresh READ-ONLY Codex pass with
`./forge grill run --gate <gate> [--task <id>]` that reads the plan/contract
cold and returns findings — never a
Claude sub-agent, never grill your own work inline — then carry ALL of those
findings into your own AskUserQuestion rounds (the recorder rejects rounds not in
the ledger, so the top-level session must still ask). Read cold, as an adversary
who did not write it.

ONE COLD READ PER GATE — put every question to the human INSIDE it. The old
shape was Codex grill → your rounds → amend → Codex grill AGAIN, looping until
clean. That loop cannot converge: a fresh reader has no memory of what the last
one found, so it returns a DIFFERENT frontier rather than a shorter one, and the
artifact you amended to close round one becomes round two's input. Stories
reached eleven, twenty-six and forty rounds that way; the last cost six hours.
`forge grill run` now REFUSES a second unconstrained read on a gate that has
already been read since its last recorded pass.

So the WHOLE grill is:

1. `./forge grill run --gate <gate>` — one cold read. WATCH it.
2. Clean? Record the pass and approve. Nothing else happens.
3. Otherwise resolve every finding the REPOSITORY answers yourself — open the
   file and settle it. Take to the human only what the repository cannot
   answer: a decision nobody has made, a priority, a tradeoff between two
   workable shapes. Put those through AskUserQuestion with your recommended
   answer first, all of them, now. There is no later round to save the hard
   ones for, and a finding is not a menu.
4. Amend the artifact ONCE, to what they decided.
5. Record the pass against the AMENDED version, then approve exactly once.

The price is stated plainly, twice over: nothing independent re-reads the
amended version, and a gap this reader misses is not caught by a second reader
at this gate. Both surface at the next gate, or in review. That is the trade
for ending a loop that was costing whole days.

If the human's answers changed the artifact's SHAPE — a component dropped, a
different approach chosen — the amended artifact is not the one that was read
in any useful sense. Say so and read again: `./forge grill run --gate <gate>
--reread "<what changed shape>"`. It is a choice with a recorded reason, not a
way around the rule, and the five-read cap still backstops it. (EVERY gate is ledger-matched — signoff and epics no
longer excepted — so no gate can be recorded by a read-only Codex grill alone:
the top-level session asks the round and records it.)

FRESH CONTEXT, AND THE ANSWERS SO FAR. Every round is a NEW read-only Codex
session — that independence is the whole point. But a reader that knows nothing
of the earlier rounds does not re-find the same gaps, it finds DIFFERENT ones,
so the rounds never shrink and the grill has no natural end. `./forge grill run`
therefore carries every question already put to the human and the answer they
chose, read from the ledger the recorder validates against.

That gives the reader two obligations: do not re-raise settled questions, and
CHECK EACH ANSWER — that the artifact honours it, and that it contradicts no
other answer, accepted decision or constitution rule. An answer can be wrong, or
right and never applied; saying so is part of the read.

Do NOT tell the reader where to concentrate. A cold read is worth having because
it is unconstrained, and steering it toward the diff is how the thing nobody
looked at survives every round. More information, no direction.

END EVERY ROUND WITH AN EXPLICIT CONVERGENCE VERDICT, on its own line, so the
coordinator never has to guess whether to grill again or approve:

- `CONVERGED — no gaps, no contradictions, plan unchanged since the last round`
- `NOT CONVERGED — <the specific reason: open gaps, a contradiction, or the plan
  changed after the last clean round>`

`CONVERGED` on the cold read means there is nothing to amend: record and
approve. `NOT CONVERGED` does NOT mean read again — it means resolve what the
repository answers, put the rest to the human, amend once, and record the pass
against the amended version. Approval happens exactly once.

Five gates, five scopes:

- `--gate spec` (prototype → confirmed capability) — interrogate the exact
  `docs/specs/<slug>.md` file against BRIEF, architecture, decisions, and the
  prototype. Hunt: behavior the prototype proved but the spec omitted,
  implementation choices masquerading as requirements, vague acceptance
  language, and conflicts with active decisions.
- `--gate signoff` (client → PM, before `record_signoff.py`) — interrogate
  `docs/product/DISCOVERY.md`, `BRIEF.md`, confirmed specs, the spec-linked
  roadmap, `docs/decisions/`, and prototype notes. Hunt: unanswered
  stakeholder/constraint questions, scope
  the client saw vs. scope the BRIEF claims, decisions that contradict the
  BRIEF, acceptance criteria that are vibes instead of checks, non-functional
  requirements nobody asked about (auth, data retention, environments).
- `--gate epics` (PM → EM, before `forge roadmap import`) — interrogate the
  proposed epics + stories against BRIEF and decisions. Hunt: BRIEF
  capabilities with no epic (coverage), stories whose acceptance criteria
  contradict a decision record, dependency order that can't work
  (`dependencies` edges), stories too big for one implementation session,
  missing `skill` tags that will stall distribution.
- `--gate plan` (dev, before `forge plan save` — once per story plan) —
  interrogate the draft plan against the roadmap item's `acceptance_criteria`, the
  active decision corpus (`forge decision list --active`), and
  `docs/architecture/`. Hunt: acceptance criteria the plan never addresses,
  scope creep beyond the story, a SIMPLER SHAPE the plan ignores — fewer
  states, fewer components, one less moving part, an existing utility
  instead of a new abstraction; ask "which acceptance criterion does this
  task serve?" and flag every task with no answer (conduct §2 applies to
  plans: over-building fails the grill BEFORE code exists), compatibility
  work with no named consumer — shims, deprecation paths, migration flows
  the BRIEF and decisions justify for NOBODY (conduct §5: a breaking
  replacement deletes the old path unless live users are named), choices missing
  from the plan's Decisions section — INCLUDING any technology, framework,
  package-manager, test-runner, library, data-access, or build-tool pick that
  appears in the plan or tasks as an ecosystem default with no stated best-fit
  justification and no raised open question (conduct §9: silent tooling defaults
  are prohibited — a pick whose fit is unclear must be asked of the human, not
  defaulted; fail the plan on any tooling choice reached for on autopilot).
  Also flag a MISSING quality-gate baseline: any codebase the plan touches must
  wire a stack-APPROPRIATE static-analysis gate — a linter AND formatter, plus a
  type-checker where the language has one — into CI/verify, not merely a test
  runner. Name the CAPABILITY, never a fixed tool: ESLint/Biome for JS-TS,
  Ruff/flake8 for Python, golangci-lint for Go, Clippy for Rust, Checkstyle/
  Spotbugs for Java, and so on — the requirement is generic to every backend, not
  one ecosystem's tool. Fail the plan when code ships with no configured lint/
  format/static-analysis gate that an automated check enforces on every push; an
  absent linter is a silent quality default exactly like an unjustified tool pick.
  Also hold the plan against the CONSTITUTION's coding standards
  (`constitution/README.md` index — read the references it maps to the plan's
  surfaces). The constitution is law, so a plan whose SHAPE omits or contradicts a
  mandated standard is a GAP, not a style preference: HTTP surfaces with no typed
  request AND response DTOs (`pnp-api-standards`, `pnp-swagger-api-documentation-
  standards`), a module ignoring the modular-monolith layout or file-suffix
  standards (`pnp-coding-standards-modular-monolith`, `03`), missing structured
  logging (`05`/`06`) or domain exception handling (`07`), an external integration
  that skips the provider/port pattern (`08`, `pnp-provider-pattern-for-
  integration`), or database work ignoring `pnp-database-standards`. Flag each and
  require the plan to conform or record a deliberate, written deviation — never
  wave it through as "the implementer will follow standards later"; a plan must not
  design AGAINST the law. (`constitution/` is on disk in every environment, so the
  read-only Codex cold-read has the law available — hold the plan to it.)
  Reconcile the plan explicitly against
  EVERY ID from `forge decision list --active`; a conflict becomes a
  contradiction signal or a superseding decision, never a silent exception.
  Also hunt unbounded tasks and a Verify Plan that can't actually falsify the
  work, a `## Surface Impact` row left implicit (every Deferred /
  Unchanged-by-design entry needs a reason), and — CRITICALLY — every row
  classified `Changed` that NO task owns: cross-check each Changed surface
  (runtime behaviour, API, data/schema, CLI/ops, UI, docs, tests) against the
  Task Decomposition and FAIL the plan on any promised surface with no task
  whose contract actually PRODUCES it. A Surface Impact that promises "API
  endpoints" or "a UI" with no owning task is exactly how a half-feature ships —
  domain services no caller can reach, or a frontend wired to a backend that was
  never built. Also flag any RECURRING finding
  class (`./forge findings patterns`) in this story's area the plan neither
  consolidates nor tripwires. In Claude Code the
  `/grill-me` skill run against the plan satisfies this contract. The payload
  carries `"issue"`; the recorder stamps it against the active task.
- `--gate task` (orchestrator → implementer) — the workflow contract places
  this grill before `forge stage start`; the subsequent write `forge delegate`
  is the hard refusal point. Interrogate the next leaf task's just-authored
  contract in the re-recorded decomposition against the approved story plan,
  active decisions, and the actual repository state left by completed prior
  stages. Hunt: assumed files or APIs that prior work did not produce, a
  `write_scope` whose AREAS miss where the work must land or reach into areas
  the task has no business in (scope is directory prefixes plus named new
  files — a missing existing file under a declared prefix, a drifted line
  number or a renamed module is a NON-BLOCKING note, never a blocking finding;
  `stage done` measures the exact paths), acceptance criteria not served by the proposed
  work, a task that OWNS a plan `## Surface Impact` surface but whose
  `write_scope`/`required_tests` do not actually PRODUCE it (owns the API row but
  builds only domain services with no HTTP controllers/DTOs/routes; owns the UI
  row but ships no components) — reachability is part of "done", not a later
  task's problem, required tests that do not prove those criteria, verify commands that
  cannot falsify the change, reviewer focus that misses the risky seam OR that
  re-states shape rules the constitution already sets instead of CITING the
  load-bearing `constitution/` references for the task (the contract points at the
  law, never re-derives or contradicts it), and a
  `user_facing` flag that misclassifies the task — a UI task left `false` (its
  mandatory design skills and design review would be skipped) or a backend task
  marked `true` (forced to attest UI design skills it has no use for).
  This is the JIT task-planning gate from decision 0032, not a repeat of the
  story-level plan grill. Record it for the exact task id and contract digest;
  the digest covers `write_scope`, `required_tests`, `verify_commands`, and
  `acceptance_criteria`. A changed field makes the old task grill stale, and a
  write delegation refuses it; read-only delegation is unaffected.

Method:

1. Read the artifacts in scope FIRST; derive your question list from actual
   text, citing it (`BRIEF.md says X; decision 0003 says Y — which wins?`).
2. Interrogate in ROUNDS until the frontier is empty — not one pass. Each
   round, put the questions whose prerequisites are already settled to the
   human (PM or EM) with your recommended answer; their answers reshape the
   tree and unblock the next round's questions. Stop a single question when it
   would only confirm what a document already states; stop the grill only when
   no gap or contradiction remains unasked. In Claude Code, deliver each
   round's frontier through the AskUserQuestion tool (recommended answer
   first), not prose. For every ledger-matched gate (`spec`, `requirements`,
   `plan`, `task`) the recorder requires
   the FINAL round in the payload to carry `"frontier_empty": true` — that flag
   is how it confirms you stopped because the frontier closed, not because you
   ran out of patience; it is set by hand on the last `rounds` entry, never by
   the ledger. A zero-gap contract still needs at least one such round (every
   gate's floor is 1, and a floor is not a target), so ask a genuine closing
   question
   (e.g. "any remaining gap before we hand off?") and mark it `frontier_empty`.
3. Every finding lands somewhere real before the verdict: a doc edit, a
   `./forge decision new <slug>` record, or an explicit non-blocking entry
   in `open_items`. An `open_items` entry that PARKS scope also gets a
   deferral row with a revisit trigger (`./forge defer add`) — parked scope
   without a trigger is scope silently dropped. Unresolved blocking
   findings ⇒ verdict `blocked`.
4. Record the outcome (schema: `factory/schemas/grill.json`,
   `"generated_by": "griller"`):

   A task-grill input uses this recorded shape (the recorder adds its own
   task id, digests, commit, and timestamps):

```json
{
  "generated_by": "griller",
  "verdict": "pass",
  "gaps": [],
  "contradictions": [],
  "resolutions": ["What was sanctioned"],
  "inspected_refs": ["path/or/path:symbol"],
  "current_flow": "What the repository does now",
  "criteria_map": {"criterion": "proof"},
  "decision": "keep",
  "new_abstractions": ["None"],
  "rounds": [{"question": "Finding or choice", "options": ["Recommended", "Alternative"], "chosen": "Recommended", "frontier_empty": true}],
  "citations": [{"finding": "Repo-answerable finding", "source": "path:symbol"}],
  "open_items": []
}
```

   Each `rounds` entry has a non-empty `question`, two to four non-empty
   string `options`, and a `chosen` value equal to one option. Each citation
   is `{finding, source}`. Every string in `gaps` must be covered by an equal
   `rounds[].question` or `citations[].finding`.

   For every gate — all six are ledger-matched — extra recorder rules bind
   (this is what makes an otherwise well-formed payload fail):
   - Rounds must match the AskUserQuestion ledger and meet the gate floor
     (1 for every gate, and a floor is not a target); the final round carries
     `"frontier_empty": true`. A
     zero-gap grill still records its floor of real rounds — never zero.
   - `--gate task` only: `criteria_map` is a THREE-WAY equality — its KEYS must
     equal the frontier task's `acceptance_criteria` set AND the set of its
     `plan_contracts[].statement` values, exactly (no extra key, none missing);
     each value is the non-empty proof for that criterion. Author the task's
     `acceptance_criteria` and its `plan_contracts` statements as the SAME
     strings so there is one coherent key set to satisfy.

```bash
python3 factory/scripts/record_grill_from_json.py --gate <spec|signoff|epics|requirements|plan|task> --input <json> [--input-digest <artifact>] [--task <id>]
```

5. For every gate except task, commit the resolution edits
   BEFORE recording the grill — those gates check freshness against BOTH
   committed history and the working tree: any guarded doc changing after the
   grill (even uncommitted) stales it. (The sign-off / epics-approved decision
   records themselves are expected afterwards and don't stale it.) The task
   gate instead binds directly to the re-recorded task contract digest; the JIT
   sequence does not require a commit between re-recording and grilling. But that
   digest still folds in the product tree, so record the task grill LAST — after
   any docs/ or factory/scripts commits: a tracked change outside .factory/ and
   plans/ that lands between grilling and `task approve`/`stage start` re-stales
   it and forces a re-grill.
6. `--input-digest` is REQUIRED for the spec, epics, and plan gates: pass the
   exact spec / roadmap input / plan draft you interrogated. The gate verifies the
   digest — grilling version A never approves an edited version B; if the
   artifact changes, re-grill it. For `--gate task`, pass `--task <id>` and NO
   `--task-digest` — that flag was removed and the recorder rejects it; the
   recorder derives the grounding digest itself from the protected contract,
   approved plan, and product tree, and stores the result at
   `.factory/grills/tasks/<id>.json`.

A `pass` with unresolved findings is refused by the recorder. Grill hard;
downstream implementation inherits whatever you let through.


## Lessons already in force for these paths

The plan must design AROUND these. A plan that ignores one is not merely unlucky later — it is wrong now, and saying so is part of this read.

- Runtime state, jobs, control events, and memory use Postgres as the production storage model; schema or repository changes need repository tests and architecture/docs updates when contracts shift.
- Keep provider-specific and channel-specific behavior behind adapters; domain and application code should depend on stable product concepts and ports, not SDK payloads or runtime wiring.
- Risky tool execution must pass through deterministic permission evaluation and sandbox policy before any provider callback or runner grants access.
- Run the focused Prettier check after adding or reshaping TypeScript tests so the deterministic structural gate does not rediscover formatting drift.
- The full npm run test:unit lane can finish the LIVE-1 surfaces and then remain silent without a Vitest summary in this checkout; do not call it green without the exit code, and preserve focused lane evidence separately.
- Managed command policy can reject required VITEST_JUNIT/FORGE_TEST_ID commands when the exact testcase identifier contains a literal greater-than separator. Report the wrapper lane as blocked and do not call it passing.
- Managed command policy can refuse the required FORGE_TEST_ID when its exact test name contains a greater-than character; report the policy refusal separately from focused test evidence.
- A jobs or runner directory-wide Vitest invocation can remain live without a summary or exit code in the managed environment; terminate it after bounded polling and report it as unverified, not green.
- A focused Vitest selector can complete its test but still exit 1 when the macOS watcher hits EMFILE; treat this as blocked verification and rerun with the canonical wrapper or a watcher-safe environment.
- Postgres JSONB normalizes object key order and drops undefined; any equality check against persisted state (JSON.stringify ===) silently fails in prod while structuredClone-based fakes keep it green. Compare with util.isDeepStrictEqual and make repository fakes persist through a JSONB-faithful round trip (see test/unit/application/jsonb-round-trip.ts).
- Managed execution can reject a required test when an inline environment assignment is the command prefix, reporting that the shell wrapper hides prefix inspection; invoke the same command through env so the executable prefix is visible, and report any remaining refusal separately.
- Managed command policy can refuse required Vitest commands when a leading environment assignment obscures the inspected prefix; preserve the refusal and run an equivalent direct Vitest JUnit command separately.
- In the IPC merge helper treat EVERY base rail ASK as requiring approval and exempt only the two relaxable conditions (out_of_trusted_root; unsupported_meta_executor AND readOnlyMetaExecutor) via relaxesRailVeto — autoreview r2 P1: railRequiresApproval was false for soft ASKs such as RailSignal.Destructive, so a classifier allow reached the auto-allow path without rail provenance. Add a negative leaf per non-relaxable signal.
- CORRECTS lesson 66: T1 must not turn every non-relaxable rail ASK into a classifier veto. Today a non-hard-floor ASK (e.g. RailSignal.Destructive for an ordinary single-file delete) is classifier-eligible and cacheable — pinned by the existing rails test 'keeps an ordinary single-file delete eligible for classifier allow and caching' — and the T1 contract keeps that byte-for-byte. Veto = hard-floor asks (missing/redacted/truncated input, protected/secret paths, capability gates) exactly as before; relaxation = the two signals; everything else = today's behaviour, no new veto.
- Gate cached-verdict consumption and any auto-allow from it on the lane: a classifier allow cached while in auto must never be reused after switching to permissionMode ask (ask mode has no classifier authority), and auto_strict keeps its veto behaviour — autoreview r3 P1: with every analyzed rail ASK now reaching the cache stage, an ordinary single-file delete cached in auto was executed as auto_classifier in ask mode without a prompt. Add an ask-lane cached-allow negative leaf.
- On a task touching 20+ files the Codex run hits the compaction limit after about 90 read commands; the source files are already complete and committed (checkpoint 5e060951a, tsc clean), so do NOT re-read finished source files — start from git status and the required_tests list, write or finish ONE test file at a time (run only that file with vitest), and stop reading the brief's cited source lines you have already implemented.
- Remaining T2b work after the checkpoint is ONLY: (1) test/unit/runner/tool-permission-gate.test.ts:1347-1358 — re-point the CAPSAFE-1-BOUNDARY import from the deleted gantryToolDefaultRisk to gantryToolRisk and assert capability_run is high; (2) test/unit/runtime/permission-classifier.test.ts — replace the 'auto-approves a routine gantry mutation via the deterministic map' expectation (medium is gone) and make the lane-independent-high leaf pass (the consult stub must not be invoked for a table-judged tool); (3) create test/unit/runtime/browser-file-attach-source.test.ts; (4) the remaining required_tests leaves in ipc-permission-classifier-decision, ipc-file-artifact-handlers, file-tool and askfloor-tap-budget. Source files are complete and committed; do not re-read them.
- Exactly six required leaves are still missing; every source file and every other suite is complete, committed and green (tsc clean). Write ONLY these six it() titles verbatim, one file at a time, running only that file after each: - apps/core/test/unit/jobs/ipc-file-artifact-handlers.test.ts: it('hides protected entries from list with a protectedHidden count and refuses a protected read by id and by path with the fixed not-a-permission-question text') - apps/core/test/unit/runner/mcp/file-tool.test.ts: it('appends the protected-entries-hidden line to list output only when the count is positive and relays a protected read refusal unchanged') - apps/core/test/unit/runner/tool-permission-gate.test.ts: it('keeps capability_run high through the typed table for the CAPSAFE-1 boundary with no classifier-derived or cached allow') - apps/core/test/unit/runtime/askfloor-tap-budget.test.ts: it('TB1 TB2 TB3 TB4: a browser click, a file read by path, an unprotected file write and a native FileWrite inside the workspace cost 0 taps in interactive auto with the LLM consult not invoked') - apps/core/test/unit/runtime/askfloor-tap-budget.test.ts: it('mirror fixtures: a protected file write, a FileWrite outside the workspace and scheduler_delete_job cost 1 tap, and a raw-path file_attach reaches the stubbed LLM consult as ambiguous') - apps/core/test/unit/runtime/askfloor-tap-budget.test.ts: it('keeps today's outcome for the TB1 TB2 TB3 TB4 fixtures under auto_strict, ask and autonomous')
- T2b is implemented (commit 3d31be483, 15/15 leaves green). This run makes ONLY the bullet-13 change: in evaluateNativeRiskBranch, an ambiguous gantry verdict returns the native ask result when lane is undefined (still undefined under interactive_auto and auto_strict); then extend the lane-independent-high leaf in test/unit/runtime/permission-classifier.test.ts to its recorded title (an unregistered suffix with the lane absent yields the native ask) and run that suite plus test/unit/bootstrap/inline-agent-loop-tools.test.ts. Do not re-read the other 21 scope files.
- T3a order that fits one Codex run: (1) schema.ts + port + repository + domain/types.ts + the shared boundary canonicalPath, then run npm run db:migrations:generate -- --name permission_decision_memory_human (NEVER hand-write the SQL or snapshot; commit what drizzle-kit emits), then npx tsc --noEmit; (2) the scope-key module and the service; (3) tests ONE FILE AT A TIME in this order — provenance, scope, service, prospective-write pin, Postgres suite — running each file right after writing it and never re-reading a finished source file. Postgres tests need the TEST database: run 'source /private/tmp/claude-501/-Users-ravikiranvemula-Workdir-myclaw/b4051e43-dbea-4d62-ba73-ae6210455474/scratchpad/pgfix-env.sh' in the same shell before vitest (it exports GANTRY_TEST_DATABASE_URL for gantry_test; the live database gantry must never be touched). Required leaf titles are exact it() names from the brief.
- Run 1 of ASKFLOOR-1-T3b died mid-turn (companion failure) after writing most of the implementation; the working tree ALREADY holds it uncommitted: modified port, Postgres repository, provenance map, coordinator, inline tool types, inline tools file, scope helper, the Postgres/service/scope tests and the architecture doc, plus NEW runtime/permission-human-memory-stage.ts, app/bootstrap/inline-permission-memory.ts and test/unit/runtime/permission-human-memory-stage.test.ts. CONTINUE from that tree — never reset, never re-create files that exist; read them first. Run 1's last note: the core types and source wiring compile; the six contract-named leaves were being added (stage leaf first). Finish: the six leaves by their exact titles (ids are matched verbatim by the gate), the inline suite cases, the inline-permission-memory unit suite, tsc, check:architecture, prettier, and keep inline-agent-loop-tools.ts under 750 lines. Postgres leaves cannot run in the sandbox (EPERM 127.0.0.1:5432); the host runs them — do not raise a blocked signal for that.
- Run 3 of ASKFLOOR-1-T3c also died on the Codex compaction bug; the tree now holds 18 modified files plus NEW permission-remember-codec.ts, human-decision-learning.ts, permission-remember-settlement.ts and their three suites (codec, learning, control). Run 3's last note: the IPC and recovery chokepoints share the persisted claim accessor, the context is written before delegation, learning runs after the claim and immediately before application, and runtime-store supplies the decision-memory repository. CONTINUE from that tree — never reset. Remaining, in order: the inline path (inline-permission-memory.ts context derivation + afterDecision learning; inline file under 750 lines), the Postgres mapper validation + its integration case, the provider-affordance parity case, the S2 harness/fixture, then the twelve leaves by their exact titles, tsc, check:architecture, prettier. Commit nothing; the host commits. Keep each step small so a compaction cannot lose it.
- Run 4 of ASKFLOOR-1-T3c died on the Codex compaction bug with the bulk of the task in the tree: 26 files, about 1,700 lines, uncommitted. CONTINUE from that tree — never reset. Two ceilings are breached right now and check:architecture will fail until they are fixed: apps/core/src/domain/types.ts is 748 lines against 740 (the contract requires LINE-NEUTRAL edits there: declare PermissionRememberCode on one line and join existing multi-line declarations so the file returns to exactly 740 or fewer; nothing else may grow it) and apps/core/src/app/bootstrap/inline-agent-loop-tools.ts is 753 against 750 (move any added inline logic into inline-permission-memory.ts; the inline file may only gain the handful of call lines). ipc-interaction-processing.ts is 851/865 — fine. Then finish what remains (check each: the S2 harness/fixture, the Postgres mapper validation case, the parity case, any of the twelve leaves not yet green), run tsc, check:architecture, prettier. Commit nothing; the host commits.
- CONTINUE, do not restart: the worktree already holds the previous run's uncommitted T4 work (NEW application/permissions/human-decision-job-projection.ts, NEW runtime/ipc-permission-job-projection.ts, NEW test/unit/application/human-decision-job-projection.test.ts, plus coordinator, IPC, inline, execution-phases, agent-spawn-types, types.ts, runtime-services and test-suite edits). Read git status and git diff first, keep what matches the contract, and finish the remaining acceptance criteria and the nine required leaves (the permission-management-service audit leaf, the execution suite, the inline suite split, the runtime-services wiring leaf and the Postgres leaf were not yet done when run 1 died).
- CONTINUE, do not restart: the worktree already holds the previous run's uncommitted T4 work (NEW application/permissions/human-decision-job-projection.ts, NEW runtime/ipc-permission-job-projection.ts, NEW test/unit/application/human-decision-job-projection.test.ts, plus coordinator, IPC, inline, execution-phases, agent-spawn-types, types.ts, runtime-services and test-suite edits). Read git status and git diff first, keep what matches the contract, and finish the remaining acceptance criteria and the nine required leaves (the permission-management-service audit leaf, the execution suite, the inline suite split, the runtime-services wiring leaf and the Postgres leaf were not yet done when run 1 died).
- Host verify after run 3: 9,154 of 9,157 unit tests pass; THREE failures must be fixed in this run (then re-run the full unit suite yourself: npx vitest run -c vitest.unit.config.ts). (1) apps/core/test/unit/application/jobperm-ask-and-wait.test.ts "jobperm-1-t1-card-not-cancel": TypeError reading 'risk_level' of undefined at :78 — a job request whose classifier result is ASK now reaches the card path without the risk fields the job route guard used to carry; the card payload for a job ask must keep its risk_level/risk fields exactly as before (0156 changes WHEN the classifier runs, never the card shape). (2) apps/core/test/unit/runtime/askfloor-tap-budget.test.ts "S3: 2>/dev/null and read-only find cost 0 taps in interactive auto": expected 0 taps, got 1 decidedBy owner — this is the INTERACTIVE lane, which the contract says is untouched; the coordinator's new humanDecisionProjection/guard insertion must be a no-op when the input is absent or the lane is interactive (find the exact change that altered the interactive first-ask path and confine it to job requests). (3) same file, "keeps today's outcome for the TB1 TB2 TB3 TB4 fixtures under auto_strict, ask and autonomous": the fixture harness throws "Expected the LLM classifier consult not to be invoked" for the autonomous lane — under 0156 the classifier IS consulted on a job miss, so update the autonomous row of that fixture (and the harness expectation) to the ladder: projection miss -> classifier consulted -> allow runs / ask -> card; keep auto_strict and ask rows unchanged.
- Stage autoreview P1 (must fix in this run, then re-run the IPC and coordinator suites and the full unit suite): apps/core/src/runtime/ipc-permission-classifier-decision.ts around :436 — the railAsk.hardFloor !== true check was added only to the JOB branch of the relaxesRailVeto disjunction; the interactive-auto branch still treats OutOfTrustedRoot / eligible UnsupportedMetaExecutor as relaxable when hardFloor is true, so a classifier allow can authorize across a hard rail in interactive auto. Fix: require railAsk.hardFloor !== true for BOTH lane branches (hoist the guard in front of the disjunction so no branch can relax a hard-floor ASK). Pin it in apps/core/test/unit/runtime/ipc-permission-classifier-decision.test.ts: an interactive-auto request whose ASK has hardFloor: true with each typed signal, under a live classifier allow AND a cached allow, is NOT authorized (no auto_classifier decision; the existing prompt/card path) — mirror the job-lane hard-floor cases that already exist. This is the same bug family as lesson 106: a new invariant added to one branch of a shared predicate must be applied to every branch.
- CONFIRMATION RUN — the T4 implementation is COMPLETE and COMMITTED on this branch (c48659d8e: both P1 hard-floor fixes from lessons 106 and 107 are in; the host has verified leaves 9/9, unit 9157/9157, verify.py passed, stage autoreview clean). The previous launch died in a Codex compaction error after its work landed, so this launch exists to bind a successful write launch to the stage. Do NOT restart or rework anything. Re-read the contract, run the IPC and coordinator suites (npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runtime/ipc-permission-classifier-decision.test.ts apps/core/test/unit/runtime/permission-decision-coordinator.test.ts) and npx tsc --noEmit, confirm each acceptance criterion against the committed diff (git diff 46585b469..HEAD --stat), and finish with a short report. Change files ONLY if you find a concrete contract violation; if you do, name it explicitly in the report.
- CONTINUE, do not restart (44 modified files / +1346 plus the new formatter module and suite are on disk; tsc is clean). Host check of the fourteen required leaves — DONE: place candidate (human-decision-learning), Postgres batch reset, Postgres rail-filtered count, formatter shapes, four-provider parity, Teams settlement + ActionSets, batch line. STILL MISSING, do these and nothing else, running each touched suite as you go: (1) apps/core/src/app/bootstrap/channel-message-action-router.ts has NO onMemoryForget hook yet — add the typed hook and the "Not available yet." unbound reply, then the router leaf "delivers a typed memory_forget action with the authenticated conversation identity to a bound onMemoryForget hook and answers not available yet when no hook is bound"; (2) the recovery leaf in pending-interaction-permission-recovery-orchestrator.test.ts (replays the persisted card affordances, offered-set check, receipt for offered vs unoffered); (3) the IPC leaf in ipc-interaction-handler.test.ts (model persisted on the IPC path; forged unoffered code degrades to its scalar base and learns nothing); (4) the Telegram, Slack and Discord settlement leaves with the exact titles from the contract ("passes an offered remember code verbatim into the durable claim settles it with its remembered receipt settles an unoffered code once-only with today's receipt and renders and settles a memory_forget tap on <Provider>"); (5) S4 in askfloor-tap-budget.test.ts (the destructive build-directory removal asks once; Allow remembers the exact command; zero taps on repeat; the same removal of the dist directory asks; No is remembered exactly). Then npx tsc --noEmit and the touched suites. The orchestrator commits, never you.
- CONTINUE, do not restart (49 modified files / +2146 plus the new formatter module and suite are on disk). Host check: thirteen of the fourteen required leaves now exist. ONLY these remain: (1) S4 in apps/core/test/unit/runtime/askfloor-tap-budget.test.ts with the exact title "S4 asks once for rm -rf build remembers the exact command runs it again with zero taps asks for rm -rf dist and remembers No exactly" — extend askfloor-tap-budget-harness.ts as S1-S3 do (real claim → learn → apply through the coordinator): the destructive build-directory removal asks once, a remember-allow tap stores the exact command + target, the identical command replays with zero taps, the same removal of the dist directory asks, and a remember-deny tap on it is remembered exactly (a later identical request resolves deny with human_decision provenance); (2) confirm the router's memory_forget path exposes a typed hook the host can bind and answers "Not available yet." when unbound (name it onMemoryForget if it is not already); (3) then run npx tsc --noEmit, npm run check:architecture, and the touched suites (askfloor-tap-budget, channel-message-action-router, the four provider suites) and report. The orchestrator commits, never you.
- The rail's hardFloor flag floors the classifier only (T3b-AC3); a human's remembered exact Allow on a destructive ask is honoured (story S4). Do not hoist a hardFloor guard over the interactive remembered-allow path in permission-decision-coordinator.ts — that fix broke S4 and was reverted (Q-0173).
- Not a defect (ASKFLOOR-1-T3b-AC3): ASKFLOOR-1-T3b-AC3 (sealed): the rail's hardFloor flag floors the CLASSIFIER, never a human's remembered exact decision; destructive asks consult exact memory only (story S4 pins the remembered destructive build cleanup). Hoisting the guard over the interactive remembered-allow path was the round-1 fix that broke S4 and was reverted under Q-0173. — raised as "[P1] Keep hard-floor destructive asks out of remembered allows (apps/core/src/runtime/permission-decision-coordinator.ts:273): `exactAllowCanOverride` admits ev"
- Not a defect (ASKFLOOR-1-T3b-AC3): ASKFLOOR-1-T3b-AC3 (sealed): the rail's hardFloor flag floors the CLASSIFIER, never a human's remembered exact decision; destructive asks consult exact memory only (story S4 pins the remembered destructive build cleanup). Hoisting the guard over the interactive remembered-allow path was the round-1 fix that broke S4 and was reverted under Q-0173. — raised as "Hard-floor destructive requests can be auto-approved from memory (apps/core/src/runtime/permission-decision-coordinator.ts:262): `exactAllowCanOverride` admits "
- Not a defect (ASKFLOOR-1-T3b-AC3): ASKFLOOR-1-T3b-AC3 (sealed): the rail's hardFloor flag floors the CLASSIFIER, never a human's remembered exact decision; destructive asks consult exact memory only (story S4 pins the remembered destructive build cleanup). Hoisting the guard over the interactive remembered-allow path was the round-1 fix that broke S4 and was reverted under Q-0173. — raised as "[P1] Do not let remembered allows bypass hard-floor destructive asks (apps/core/src/runtime/permission-decision-coordinator.ts:271): This branch admits every de"
- The tree already holds partial T5b work (listing module, forget handler, parser, ports, four provider branches). Do NOT re-survey: read only the cited line ranges in the brief and the files you are about to edit. Order: 1 listing module + parser + session command; 2 forget handler + wiring setter + runtime-services bind; 3 audit read port + Postgres adapter + job-name hydration; 4 label carrier on both prompt paths + guidance line; 5 the four provider in-place edits; 6 tests one file at a time, running only the touched suite after each. Everything you write survives on disk across relaunches; commit nothing, finish the slice in front of you.
- Every source file in the T5b scope is already edited, type-checks clean, and is committed. Do not re-read or rework sources unless a test proves a defect. Remaining, one file at a time, running only that suite after each: unit/runtime/group-processing.test.ts, unit/runtime/permission-decision-coordinator.test.ts, unit/bootstrap/runtime-app.test.ts, unit/bootstrap/channel-message-action-router.test.ts, unit/application/human-decision-memory-service.test.ts, unit/runtime/ipc-interaction-handler.test.ts, unit/bootstrap/inline-agent-loop-tools.test.ts, unit/runtime/prompt-profile.test.ts, unit/channels/telegram.test.ts, unit/channels/slack.test.ts, unit/channels/discord/discord.test.ts, unit/channels/teams/teams.test.ts, then unit/runtime/askfloor-tap-budget-harness.ts + askfloor-tap-budget.test.ts (S5). Each required_tests leaf id must appear verbatim as a test title.
- Implementation and every test are committed and green; tsc passes. The ONLY remaining work is npm run check:architecture, which reports exactly: (1) channels/telegram/callback-handlers.ts 910 lines, limit 900; (2) runtime/ipc-interaction-processing.ts 866, limit 865; (3) session/session-commands.ts 742, limit 740 — trim or extract the smallest helper, no behaviour change; (4-6) app/bootstrap/runtime-group-processor-deps.ts imports adapters/storage/postgres/runtime-store, config/index and config/profiles — the layer checker treats a bootstrap file named runtime-* as runtime code: rename it to group-processor-deps.ts (update its importers) so it is judged as bootstrap, which may import adapters and config. Do not touch anything else. Finish with npm run check:architecture and npx tsc --noEmit both green.
- The review found no blocker; exactly three P2s remain and nothing else may change: (1) /permissions forget <prefix> must match the prefix against the FULL record id (the short display id is a rendering of it, never the match key) — pin with a test where two records share a short-id prefix; (2) decoding the remembered place must preserve colons inside the value (split on the first separator only) — pin with a place containing a colon; (3) add the concurrent double-tap coverage each provider suite was required to carry: two Forget taps on the same row settle to one applied and one already_revoked reply. Run only the touched suites; tsc and check:architecture must stay green.
- Together with the three quality P2s these are the ONLY changes in this round: (4) the used-by lookup runs only for the rows actually rendered (the ten newest for bare /permissions, all for /permissions all), never for every remembered record; (5) job-name hydration is ONE batched read for the collected job ids, not a serial per-record loop; (6) a provider in-place edit failure must never suppress the Forget receipt — send the confirmation reply first or independently, then attempt the edit, and pin it with a test per provider where the edit throws; (7) keep behaviour otherwise identical. Run only the touched suites; tsc and check:architecture stay green.
- Final fix cycle; change nothing else. (1) After a Forget tap the re-rendered list hydrates used-by ONLY for the rows it renders (the ten newest), same as the bare listing. (2) Job-name hydration is ONE bulk repository read for the deduplicated job ids (a single list/getMany call), not concurrent per-id reads — this also bounds /permissions all to one query. (3) Slack: when the replacement view has no buttons, clear the blocks (send an empty blocks array / text-only update) so stale buttons do not linger; pin with a test. (4) Move the 'Already forgotten.' string into the listing copy owner beside the other replies. Run only the touched suites; tsc and check:architecture stay green.
- Exactly five changes. (P1, blocking) app/bootstrap/runtime-services.ts ~line 597 binds the Forget handler's resolvePerson to resolveControlApproverPrincipal; it must resolve the tapping user to the CANONICAL DM memory person through the same path the /permissions command uses — resolveCanonicalMemoryPersonId from runtime/group-person-identity (DM-gated; a group route yields null → not_found). Pin in test/unit/bootstrap/runtime-services.test.ts that the bound resolver is the canonical one and that a group route resolves to null. (P2) used-by hydration fetches only the job ids actually referenced by the rendered rows, one bulk read, and the per-record dedup must be a single Set pass, not nested loops. (Tests) integration/permission-decision-memory.postgres.integration.test.ts: the audit test seeds apps 'app-one'/'app-two' before inserting permission_decisions rows (FK); the round-trip test passes railVersion: 4 to listHumanDecisions. Run runtime-services, forget-handler, listing suites and the Postgres suite (GANTRY_TEST_DATABASE_URL is exported); tsc and check:architecture green; ceilings measured after prettier.
- The review marked two contracts partial; close them and nothing else. (AC2) PermissionMemoryListMessageView and the list-view type live in application/permissions/permission-memory-listing.ts (the required owner) — move the type there and import it from the current location; no behaviour change. (AC5) the used-by read fetches ONLY the job ids referenced by the rendered records: collect the ids from the rows being rendered, dedupe once, and pass exactly that set to the single bulk job read; add a listing test asserting the bulk read receives only referenced ids. Run listing + forget-handler suites, tsc, check:architecture; ceilings measured after prettier.
- Orchestrator ruling (signals S-0093 and S-0094 resolved): PermissionMemoryListMessageView is DOMAIN-owned by design and stays where it is; AC2's 'listing module owns the view type' clause is superseded by the layer rule (domain must not import application) and is considered implemented. Do NOT move the type, do NOT raise a contradiction about it, do NOT edit domain/message-actions.ts. The single remaining change is AC5: in application/permissions/permission-memory-listing.ts (or the forget handler where hydration is called) collect the job ids referenced by the rows being rendered, dedupe once, and pass exactly that set to the one bulk job read; add a listing unit test asserting the bulk read receives only the referenced ids. Run the listing and forget-handler suites, tsc, check:architecture; finish.
- Exactly these changes, nothing else. (P1, blocking) app/bootstrap/runtime-services.ts ~line 601: the Forget handler's resolvePerson must canonicalise the caller in the CONVERSATION's app — derive the app id with appIdFromConversationJid(action.conversationJid) (the same value the handler later uses for the memory lookup) and pass it to resolveCanonicalMemoryPersonId instead of the process-wide runtime app id; pin with a runtime-services test where the conversation's app differs from the process app. (AC5) runtime-services.ts ~626 and app/bootstrap/group-processor-deps.ts ~87 bind a job reader that ignores the id set and lists ALL jobs; bind a by-ids read (add listJobsByIds(appId, ids) to the ops job repository port + Postgres adapter if none exists, or batch the existing getJobById) so only the referenced ids are read; pin it. (AC2) application/permissions/permission-memory-listing.ts ~155 duplicates the category-noun table; delete it and call the existing shared category-noun helper the card copy uses; add the one-job and two-job used-by cases to the listing suite beside the 3+ case. Run runtime-services, listing, forget-handler suites; tsc; check:architecture; ceilings after prettier (runtime-services ≤ 1186). You cannot reach Postgres; the orchestrator runs that lane.
- Orchestrator ruling (S-0095 resolved): do NOT add listJobsByIds or touch ops-repo.ts / the jobs Postgres adapter (out of scope). AC5 is implemented by: collect the job ids referenced by the rows being rendered (≤10 for bare /permissions; all active rows for /permissions all), dedupe once, and resolve names with ONE concurrent batch — Promise.all over getJobById for exactly that set — in the reader bound at runtime-services.ts ~626 and group-processor-deps.ts ~87; never list every job. Pin with a listing test that the reader is invoked only with the referenced ids. Do not raise a contradiction about this. Then: (P1) runtime-services.ts ~601 pass appIdFromConversationJid(action.conversationJid) into resolveCanonicalMemoryPersonId (test: conversation app ≠ process app); (AC2) delete the duplicate category-noun table at permission-memory-listing.ts ~155 and call the shared helper; add the one-job and two-job used-by cases. Run runtime-services, listing, forget-handler suites, tsc, check:architecture; ceilings after prettier.
- Orchestrator ruling (S-0097 resolved, AC2 amended): permission-memory-listing.ts OWNS the category-noun mapping (CATEGORY_NOUNS + exported permissionMemoryScopeNoun). No other noun helper exists; do not search for one, do not delete the table, do not raise a contradiction about nouns. Do exactly three things and finish: (1) P1 — runtime-services.ts ~601: pass appIdFromConversationJid(action.conversationJid) into resolveCanonicalMemoryPersonId; add a runtime-services test where the conversation's app differs from the process app. (2) AC5 — in the readers bound at runtime-services.ts ~626 and group-processor-deps.ts ~87, resolve names with one Promise.all over getJobById for the deduplicated referenced ids only (never list all jobs); test that only referenced ids are read. (3) AC5 tests — add one-job and two-job used-by cases in permission-memory-listing.test.ts beside the 3+ case. Run runtime-services, listing, forget-handler suites; tsc; check:architecture; ceilings after prettier.
- Orchestrator ruling (review round 6): MemoryForgetMessageActionInput carries the agent identity as the bounded agentRouteKey — the codec key the round-3 grill ruled because Telegram's callback payload is size-limited; the host handler resolves the route-effective agentId from it. Do NOT add an agentId field to the domain input or to any provider payload; AC4 has been amended to say so. Do not raise a contradiction about it. The single remaining change: app/bootstrap/runtime-services.ts ~line 631 — the post-Forget used-by hydration (and any used-by read the Forget handler performs) must use the CONVERSATION's app id (appIdFromConversationJid(action.conversationJid), the same value the handler already uses for the memory lookup and the person resolver), never the process-wide app id; pin it with a runtime-services test where the conversation app differs from the process app. Run runtime-services + forget-handler suites, tsc, check:architecture; ceilings after prettier (runtime-services ≤ 1186 — extract a tiny helper if needed). Finish.

## Already answered on this story — verify, do not re-ask

These questions were put to the human and answered. Two obligations:

1. Do NOT raise them again as open questions. They are settled.
2. DO check each answer still holds — that the artifact actually honours it, and that it does not contradict another answer, an accepted decision, or the constitution. An answer can be wrong, or right and never applied. Saying so is part of this read.

- Q: SELF-1 — when an AI employee proposes a change to itself, what is the default for a new agent?
  A: Review-only by default; owner opts specific classes into auto-apply (Recommended)
- Q: INCIDENT-1 — what does `freeze` do to work already in flight?
  A: Soft by default: no new runs or tool calls, in-flight turns finish; `--hard` cancels immediately (Recommended)
- Q: ADMIN-ALERT-1 — where do admin alerts go in V1.0?
  A: One Teams/Slack conversation only (Recommended)
- Q: OPS-DR-1 — where do backups go?
  A: S3-compatible bucket or local path, operator's choice (Recommended)
- Q: LIFECYCLE-1 — default retention when the operator sets nothing?
  A: Messages 90 days, memory until offboarding, audit 400 days minimum (Recommended)
- Q: INTRO-1 — when does the intro card post in a channel?
  A: Once, on install, plus on first @mention by any new person (Recommended)
- Q: REVISION-1 — who can restore a prior persona/access revision?
  A: Owner for persona; administrator for access (Recommended)
- Q: Anything else to settle before I confirm these eleven specs and open the PR?
  A: No — confirm and open the PR (Recommended)
- Q: If the job card itself can't be created for a request (DB down, no group route), what should the run get?
  A: Deny the tool call with a plain reason (Recommended)
- Q: Anything else to settle for JOBPERM-2 before I confirm the spec and plan it?
  A: No — confirm and plan (Recommended)
- Q: Should attaching a skill remain separate from authorizing its declared actions?
  A: Keep separate (Recommended)
- Q: The independent cold read found no contradictions. Is the current Skills UI spec ready to confirm?
  A: Confirm spec (Recommended)
- Q: Scheduled jobs: the spec promises 'a scheduled job stops re-asking every run' (AC3) but decision 0121 says the autonomous lane never consults the learned-decision memory. Which way?
  A: Jobs consult learned decisions as grants
- Q: What does a tap mean? The spec currently learns BOTH 'Allow once' and 'Allow for future'. Fable's UX read: once must never be remembered; the remembered choice should be the default button.
  A: Allow (remembered) default; Just once; No (Recommended)
- Q: What should the default [Allow] remember when you don't pick a scope explicitly?
  A: Broadest safe scope (Recommended)
- Q: Writing files inside the workspace (FileWrite/Edit under the agent's own folders — the most common Claude-Code-auto action) is not mentioned by the spec today. Should it be judged by path (arg-aware: inside workspace = low, protected paths = ask) rather than by tool identity?
  A: Yes, judge by path (Recommended)
- Q: Two UX rules to confirm together: (a) a /permissions view that lists what was learned with 'Forget this'; (b) when the judge is down, one notice per conversation ('my safety judge is offline, I'll check with you more') and deterministic reads still allowed — not a tap storm.
  A: Both, as described (Recommended)
- Q: 'Exact action' for file writes: the effect hash today includes the full tool input (the content). Remembering a write by PATH only means a future write of ANY content to that path is pre-approved; by full content it never matches again (you'd be asked every edit). Which?
  A: Path only (Recommended)
- Q: /permissions already exists as a central chat command that shows and sets the permission MODE. How should learned decisions appear?
  A: One command: mode + remembered list (Recommended)
- Q: How should learned decisions reach a scheduled job? Evaluated live on every job permission request (revocable instantly via Forget) or materialized into the job's own grants when the job is created/updated (stable, but Forget doesn't reach already-materialized jobs)?
  A: Live, revocable per request (Recommended)
- Q: The judge-offline notice: 'once per conversation per outage episode' — is process-local best effort enough (today's runtime is a single launchd process), or must it be cluster-durable across runtimes?
  A: Process-local best effort (Recommended)
- Q: In /permissions, a remembered decision can say which scheduled jobs it covers. Show only jobs that have ACTUALLY used it (from the job's permission audit trail) or every job that MIGHT match it in future?
  A: Actually used (Recommended)
- Q: A card that already has a CARDSIMPLE-1 family rule ('Allow for future: all npx vitest commands') would now show two remembering buttons: the new [Allow] plus the family one. How should that card look?
  A: One remembering button (Recommended)
- Q: The `file` tool has no capability id: it is on the default tool surface and its list/read address the agent's OWN artifact store, not the filesystem. Does enabling the baseline tool itself satisfy AF-AC2's 'approved capability' clause for silent list/read, or must silent reads wait for a new literal capability id?
  A: Baseline tool suffices (Recommended)
- Q: In a group chat, when a member taps Allow/No and the host cannot resolve WHO tapped (no acting person id), what should happen?
  A: Don't remember; treat as once (Recommended)
- Q: Batch cards (several permission asks coalesced into one card with Allow all / Review each / Deny all) have no single scope to remember. Should batch cards stay once-only, with remembering available only when you tap 'Review each' and decide the members one by one?
  A: Batches stay once-only (Recommended)
- Q: Reading an attachment already in the chat (`attachment_open`): should it skip the card ONLY in auto mode (as a low-risk action the judge path allows), or in every mode including ask and auto_strict (a true birthright in the deterministic rails)?
  A: Every mode (rails birthright)
- Q: /permissions shows the 10 newest remembered decisions with Forget buttons. AF-AC8 says you can forget EVERY learned decision. How should older records be reached?
  A: Text list + forget by id (Recommended)
- Q: In a group chat the agent's request has no 'memory person' (decision 0118), so even after someone taps Allow, the next identical request has no person's memory to consult and would ask again. What should groups do?
  A: Groups: no remembering, act once (Recommended)
- Q: The ASKFLOOR-1 plan converged: Codex sol@xhigh cold-read rounds 1–17 found 68 blockers/gaps (all folded), round 18 said PLAN SOUND, round 19 re-read the unchanged plan with no findings; 9 Fable UX lanes folded; your 11 rulings are marked in the text. It is saved to plans/active (awaiting-approval) with decisions 0153 and 0154 ready to accept. Approve the plan now?
  A: Approve (Recommended)
- Q: Should re-enabling a disabled provider preserve omitted stored fields through the existing sparse PATCH flow?
  A: Preserve via PATCH (Recommended)
- Q: Should first setup prevent saving or constructing a request until a multi-method provider’s authentication method is explicitly selected?
  A: Require selection (Recommended)
- Q: How far should the plan be simplified?
  A: Default-allow table + learning (Recommended)
- Q: Decision 0155 records your default-allow ruling (gantry tools auto-allow in interactive auto, browser included; only destructive/protected writes, scheduler mutations and admin mutations ask; ambiguous shapes go to the classifier; browser network side-effects auto-allow by your choice; secret-file attach via browser counts as a protected write). The spec re-confirmation needs it accepted first. Accept 0155 now?
  A: Accept 0155 (Recommended)
- Q: Task order for implementation: the plan runs T1 (routing fix: judge's verdict stands for rail-refused reads) first, then T2a/T2b (the default-allow table). The default-allow table alone removes most browser/file/scheduler-read taps; the routing fix removes the shell-read taps. Which first?
  A: T1 routing first (Recommended)
- Q: The amended story plan (default-allow posture, decision 0155 accepted, rounds 20–25 folded, spec re-confirmed) is ready to save for your re-approval. Re-approve it now?
  A: Re-approve (Recommended)
- Q: Destructive actions (delete, overwrite, force-push style shapes) currently never remember an Allow — you are asked every time; only a No is remembered. Change that?
  A: Remember exact Allow too (Recommended)
- Q: Trust over time: after you have allowed the same high-risk tool several times (say three exact Allows for `scheduler.create_job`), should the card start offering a broader remember option for that tool ('Allow all scheduler job creations'), or should high-risk actions always stay exact-only?
  A: Offer broader after 3 exact Allows (Recommended)
- Q: Confirming the spec wording for the destructive ruling: `rm -rf build` asks once; Allow remembers that exact command and target; the identical command never asks again; `rm -rf dist` asks. Is that the behaviour you want?
  A: Yes, exactly that (Recommended)
- Q: The story plan now carries all four of today's rulings (default-allow posture, destructive exact Allow, trust growth, the governing principle) plus the T1 rails-signal ownership (A-0070). Re-approve it so implementation can start?
  A: Re-approve (Recommended)
- Q: The plan schedules your live tap-test on Telegram right after T2b (attachment read + `cd ~/Workdir/<repo> && ls`). Do you want to do that live test yourself, or should I rely on the replay fixtures only and not interrupt you?
  A: I'll do the live test myself (Recommended)
- Q: ASKFLOOR-1-T1 (routing: the judge's verdict stands for rail-refused reads in interactive auto) went through 9 Codex contract grills; every finding is folded and the story plan now matches the contract. Go: record the grill, approve the task plan, start the stage and delegate T1 to Codex sol@xhigh?
  A: Go (Recommended)
- Q: Codex paused before writing anything: T1's grilled contract spans 22 files (12 source + 10 test, 16 required leaf tests) but the stage's default review budget is 8 files. Same wall as CARDSIMPLE-2. Raise T1's budget to 26 files / 1800 lines and resume?
  A: Raise to 26 files / 1800 lines (Recommended)
- Q: Autoreview for ASKFLOOR-1 stages touches the permission engine. Use the default single Codex sol review per stage, or a two-reviewer panel (Codex sol + Claude Fable) on each stage's diff for this story?
  A: Single Codex review
- Q: T2a makes attachment_open a birthright judged on shape only. An attachment id the display sanitizer shortened (over 500 characters) or redacted (token-like) will still ask, because the rails keep today's sanitization veto. Today's generated ids are short (`message-attachment:…`). Accept that limit for T2a, or widen T2a with a sanitization change so any host-valid id never asks?
  A: Widen T2a
- Q: T2b makes every gantry-native tool LOW by default in interactive auto, except the closed high-risk rows. Four generic executor tools (async_run_command, async_mcp_call, mcp_call_tool, capability_run) run other commands or tools with whatever arguments they get; they are HIGH by identity today and not in the spec's high-risk rows. How should the table treat them?
  A: Ambiguous → judge (Recommended)
- Q: Browser file actions with a raw filesystem path (file_attach with a path, or file_upload with a path source) do not read from the agent workspace: the browser executor resolves relative paths under the session's extra directory and only accepts files under that directory or the OS temp directory; anything else is rejected at execution. Decision 0155 currently says such paths are LOW inside the workspace and HIGH outside or protected or secret, which cannot be proven against the real root. How should T2b judge these rows?
  A: Ambiguous → judge (Recommended)
- Q: Your executor ruling makes the whole DURABLE_GRANT_EXCLUDED_DISPATCHERS set ambiguous, but that set includes capability_run, and accepted decision 0130 (CAPSAFE-1) requires capability_run to stay HIGH with no classifier-derived or cached allow; an existing test pins that. Which decision wins for capability_run?
  A: 0130 wins (Recommended)
- Q: When you have a remembered Allow for an exact action and later tap a remembered No for the same action (or the reverse), what should happen to the earlier record?
  A: Newest wins, in place (Recommended)
- Q: The exact-command memory key includes the safety-rules version, so after a rules update an old exact Allow/No can never be found again (it silently stops applying and the card asks normally). Only kind- and place-scoped memories can show the line "Asking again — the safety rules were updated since you last decided this". Which do you want?
  A: Keep it simple (Recommended)
- Q: After a safety-rules update, what should happen to an old kind- or place-scoped memory (the exact ones already just stop applying, per your earlier choice)?
  A: Same as exact: stop applying (Recommended)
- Q: T4 makes jobs stop asking the classifier (decision 0121). Today a scheduled job's borderline tool call can still get a quiet 'low risk' allow from the classifier. After T4, a job call runs only if you remembered an Allow for it, or a declared rule covers it; otherwise it takes the deterministic path (cancel or card). Keep that strict behaviour?
  A: Keep classifier low-allow for jobs
- Q: A remembered Allow projected into a job is re-checked against the safety rails (same as your remembered Allows in chat). It can clear an overridable ask but never a hard rail. Confirm?
  A: Re-check against rails (Recommended)
- Q: Given 0121 was your own ruling against classifier flip-flops on jobs, which way for T4?
  A: Reverse 0121: classifier judges jobs
- Q: On the permission card, how should the remember scopes be worded?
  A: Plain nouns (Recommended)
- Q: When a high-risk tool earns the broader option after three remembered Allows, how should the tool be named in "Allow all <tool> actions"?
  A: Human label (Recommended)
- Q: How should the Forget buttons in the memory listing be labelled?
  A: Forget <shortId> (Recommended)
- Q: Decision 0154 says that after a safety-rules update the next card should say "Asking again — the safety rules were updated since you last decided this." Your T3b ruling made old-version memories simply inert (no stale flag). Showing that line means a lookup for old rows on every card. Which?
  A: Drop the line; amend 0154 (Recommended)
- Q: The trust-growth button says "Allow all <tool label> actions". Some tools have no human label registered. What then?
  A: Use the card's tool name, else no button (Recommended)
- Q: In the /permissions list, a remembered decision can show which jobs actually used it. If a job that used it has since been deleted, what should the row show?
  A: Omit the deleted job (Recommended)
- Q: When more than two jobs used a remembered decision, the row shows two names then '+N jobs'. Which two?
  A: Two most recent uses (Recommended)
- Q: Dates in the list ('2 Sep'): use the runtime's configured timezone with a day-and-month format?
  A: Configured timezone, day + month (Recommended)
- Q: Tapping Forget removes the row from the list message in place where the provider allows editing. May T5b touch the four provider action handlers to do that?
  A: Yes, edit in place (Recommended)
- Q: Listing rows: the stored record keeps the outcome, risk category, tool, place, approver label and date, but for an exact-action row the exact call is only a hash. How should a row read?
  A: Recoverable copy only (Recommended)
- Q: Folding round 2 pushes T5b to roughly 55 files / 5,000 lines (host injection path, label carrier through the run registry, Discord deferred-update path, forget-handler module). Ship as one task or split?
  A: One task, widened budget (Recommended)
- Q: The "used by job" read scans the permission audit table by JSON field once per /permissions in a DM. Accept the scan or add an index migration?
  A: Accept the scan (Recommended)
- Q: T5a's three-lens review found 3 P1s (one real security hole: hard-floor destructive asks can be auto-approved from a remembered Allow) and 4 P2s. The stage is done, stages don't reopen, and `forge delegate` only writes inside an active stage, so Codex cannot apply the fixes through the normal path. How should the fixes land?
  A: Degraded windows now (Recommended)
- Q: The three-lens review round 1 made me add a hard-floor exclusion to the destructive exact-memory consult in permission-decision-coordinator.ts. That was wrong: it breaks the story's S4 contract (a destructive build-clean command is remembered and runs with zero taps on repeat) and contradicts the approved T3b-AC3 text ("never the rail's hardFloor flag"). The review's round 2 now asks for even more hard-floor gating. Reverting my one-line exclusion is essential, but the auto-mode classifier blocked that edit. How do you want to proceed?
  A: Allow the revert (Recommended)
- Q: At stage done, what should still refuse? Today write scope, review budget, test naming and verification all refuse the seal.
  A: Refuse only on failing verification (Recommended)
- Q: Is 'only Codex writes product code' a principle or a habit? T5a needed eleven degraded windows because the writer could not act after stage done or without network.
  A: Bounded coordinator fixes allowed (Recommended)
- Q: Is the plan review a gate or a review? A gate binds to bytes and refuses on drift; a review records findings against a version and lets you decide.
  A: Review that records, not a gate (Recommended)
- Q: Per-task PRs or story PRs? Per-task drives the marker, frontier, reconcile and PR-contract machinery; story PRs remove it but batch the review.
  A: Per-task PRs, kept (Recommended)
- Q: The re-vendored harness hashes plans without the save-owned frontmatter, so the ASKFLOOR-1 plan approval and T5a's task-plan approval you already gave now read as stale. Nothing in either plan changed. May I re-record both on your behalf (`forge plan approve --by "Ravi"` + `plan save`, re-record the T5a task grill from its existing rounds, `forge task approve ASKFLOOR-1-T5a --by "Ravi"`) so T5a can ship?
  A: Yes, re-record both (Recommended)
- Q: How do you want to sequence the harness fixes?
  A: After T5b ships (Recommended)
- Q: T5b's PR #496 is in CI. T6 (judge outage latch, invariance suite, tap budget) is the last ASKFLOOR-1 task, user-facing, with no contract yet. How do you want T6 handled?
  A: Plan T6 now in plan mode (Recommended)
- Q: Six merged ASKFLOOR-1 task worktrees (T2b, T3a, T3b, T3c, T4, T5a) are clean, fully merged, and take 7.2 GB. Remove them now?
  A: Remove the six now (Recommended)

## The artifact under interrogation (task plan ASKFLOOR-1-T6)

# ASKFLOOR-1-T6 — Judge outage latch, invariance suite, tap budget S6

## Context
T1–T5b made the permission judge real: typed status (T2a), remembered decisions (T3), job projection (T4), cards and `/permissions` (T5a/T5b). When the judge is UNAVAILABLE today the classifier fails closed to ask (`runtime/permission-classifier.ts` `failedResult`: `status: Unavailable`, `risk_level: 'high'`, reason "Classifier unavailable (<code>); ask the user."), so an outage silently turns into a card storm with an opaque reason. T6 makes an outage legible and bounded: ONE plain notice per episode before the first offline card, a one-line reason on that card, Allow still remembering, deterministic read-only allows still short-circuiting, and an explicit invariance suite proving every other lane is untouched. It is the last ASKFLOOR-1 task. Seam map: scratchpad `askfloor-1-t6-seam-map.md`.

## Owner rulings (story plan line 167, Ravi 2026-09-02)
- Latch is PROCESS-LOCAL, in-memory, keyed by (app id, provider account id, conversation id); set on the first `unavailable`, cleared on the next `answered`; best effort (single launchd runtime today; worst case one duplicate notice per extra runtime). No persistence.
- Notice copy: "My safety judge is offline, so I'll check with you more than usual until it's back." — sent ONCE per episode BEFORE the first offline card.
- Card reason line: "Asking because my safety judge is offline." rides on `request.decisionReason`.
- [Allow] keeps writing the memory while offline; deterministic read-only allows still short-circuit (the read-only gate runs inside the classifier before any LLM path, `permission-classifier.ts:315`).
- `wiring_missing`: when a caller bypasses consultation because required wiring is missing (IPC guard `ipc-permission-classifier-decision.ts:359-364`; inline guard `inline-agent-loop-tools.ts:372`), the caller produces an explicit `unavailable` result with `failureCode: 'wiring_missing'` so the latch, notice and reason fire on both paths.
- T6 owns AF-AC6 (invariance suite) and adds AF-AC8 S6 plus the aggregation run; it does not edit earlier-owned tests.
- D-0080 (T5b follow-ups) stays deferred: T6 touches none of the listing, Forget-binding or used-by files.

## Orchestrator rulings (from exploration)
1. **One latch module, application-owned.** NEW `application/permissions/permission-judge-outage-latch.ts` (pure: `createJudgeOutageLatch()` → `{ observe(status, key): { noticeDue: boolean }, reset(key) }`, plus the two copy strings). Both consult paths are runtime-layer (`architecture-map.json:94-120` puts `app/` and `runtime/` in runtime) and may import application/ and shared/, never channels/. No channel import anywhere in T6.
2. **Both callers already hold the sender and the key.** IPC: `resolveIpcPermissionPromptOrTerminal` (`ipc-permission-classifier-decision.ts:547`) sends the card via `input.deps.requestPermissionApproval` at `:639` (and the denylist branch `:595`); `input.request` carries `appId`, `providerAccountId`, `targetJid`, `threadId`; `input.deps.sendMessage` is the plain-text port. Inline: the `beforePrompt` callback at `inline-agent-loop-tools.ts:449-468` runs exactly once before `prompt`; `run.appId`, `laneInput.group.providerAccountId`, `run.chatJid`, `run.threadId`, `deps.sendMessage` are in scope. The notice is a ONE-LINE call at each site (`sendMessage(targetJid, NOTICE, { threadId })`, errors swallowed like `ipc-interaction-processing.ts:616`), gated on `classifierDecision.status === Unavailable && latch.observe(...).noticeDue`. `ipc-permission-classifier-decision.ts` is 691/700 and `inline-agent-loop-tools.ts` 708/750: calls only, no logic there.
3. **`wiring_missing` joins the failure-code union** at `permission-classifier.ts:60-67` (a string union in the runtime file; no domain change). `failedResult` already maps every code except aborted/input_truncated to `Unavailable`, so the two callers construct their bypass result through the same helper shape (`status: Unavailable, failureCode: 'wiring_missing', risk_level: 'high'`).
4. **Reason line.** At the IPC ask branch (`ipc-permission-classifier-decision.ts:409` region, where `decisionReason` is read) and the inline ask branch (`inline-agent-loop-tools.ts:~418`, "Classifier requested human approval: …"), an `Unavailable` decision sets the reason to the ruled line instead of the generic text.
5. **Latch reset.** The classifier's `Answered` result clears the key; `Skipped` (cache hit, deterministic, native-risk, aborted, input_truncated) never touches the latch (T2a-AC3).
6. **Invariance suite is a table over existing fixtures**, not new logic: NEW `test/unit/runtime/askfloor-invariance.test.ts` imports `replayPermissionRequest`, `assertLlmConsultNotInvoked`, `TAP_BUDGET_WORKSPACE_ROOT`, `replayRememberedJobProjection`, `replayDestructiveExactMemory` from the harness and `permissionDecisionResult` from `test/unit/channels/permission-approval-result-helpers.ts`; one `it.each` row per lane with the exact expected tuples copied from `askfloor-tap-budget.test.ts:26/173/233` and `ipc-permission-classifier-decision.test.ts:360/385/416`, plus a second column with the consult stub returning `{ status: Unavailable, failureCode }` for the six codes — the only new assertion (today NO test pins per-lane behaviour under `Unavailable`). Inline-scheduled rows call the inline gate directly (pattern of `inline-agent-loop-tools.test.ts:1115/1450`). Family rail hit asserts `FAMILY_RULE_RAIL_HIT_REASON` (coordinator test :661); attachment_open uses the existing `attachmentOpenIds` fixture field.
7. **Harness knobs for S6** (`askfloor-tap-budget-harness.ts`, 646 lines, test-only so unbudgeted, but keep additions small): `TapBudgetFixture.classifierVerdict` gains `status` (a stub must RETURN `Unavailable`, never throw — `permission-classifier.ts:370` has no catch); `publishRuntimeEvent` and a `sendMessage` spy become injectable and are returned from `replayPermissionRequest` so the notice is countable; `replayExactMemorySequence`'s hardcoded `classifierConsult` (harness:276-280) becomes a parameter so S4's shape runs offline.

## Scope / Non-goals
In: the latch module, the two hook sites + reason lines, `wiring_missing` on both bypass guards, the latch unit suite, the IPC and inline suite cases, the invariance suite, S6 + harness knobs, the AF-AC8 aggregation run. Out: any persistence of the latch, any change to what the classifier decides, card rendering, `/permissions`, D-0080 items, a status enum change.

## Acceptance Criteria
- T6-AC1: LATCH. `createJudgeOutageLatch()` keyed by `(appId, providerAccountId, targetJid)`: first `Unavailable` → `noticeDue: true` and the key is open; further `Unavailable` on the same key → `noticeDue: false`; `Answered` clears the key; `Skipped` is ignored; keys are independent. Tests: NEW `test/unit/application/permission-judge-outage-latch.test.ts` (open/repeat/clear/ignore-skipped/independent keys/copy strings exported).
- T6-AC2: IPC PATH. In `resolveIpcPermissionPromptOrTerminal`, when the consult result is `Unavailable` and the latch says due, ONE notice is sent via `deps.sendMessage(targetJid, NOTICE, { threadId })` BEFORE `requestPermissionApproval` (both the normal and denylist branches); the card's `decisionReason` is "Asking because my safety judge is offline."; a second offline request in the same conversation sends no notice; a later `Answered` result clears it so the next outage notifies again; a `sendMessage` failure is swallowed and the card still goes out. The IPC bypass guard (`:359-364`) yields `{ status: Unavailable, failureCode: 'wiring_missing' }` instead of skipping. Tests: `ipc-permission-classifier-decision.test.ts` — notice once, reason line, card follows, no notice on repeat, reset on answered, swallow, wiring_missing.
- T6-AC3: INLINE PATH. Same contract inside the `beforePrompt` callback of the inline consult (`deps.sendMessage(run.chatJid, NOTICE, { threadId: run.threadId })`), reason line on the inline ask, and the inline guard (`:372`) yields `wiring_missing` instead of silently skipping. Tests: `inline-agent-loop-tools.test.ts` — the same seven cases.
- T6-AC4: NO TAP STORM, MEMORY STILL WRITES. With the judge offline: a deterministic read-only request inside a trusted root costs 0 taps and no notice (the read-only gate short-circuits before the LLM path); an uncovered read asks at most once per request; [Allow] with remember still writes the row and the identical repeat costs 0 taps offline (S4's shape, `source: 'human_decision'`); scheduled jobs keep deterministic denial + card recovery. Tests: S6 in `askfloor-tap-budget.test.ts` through the harness knobs of ruling 7.
- T6-AC5: INVARIANCE. NEW `askfloor-invariance.test.ts` proves every lane in AF-AC6 (ask, auto_strict, trusted-host autonomous incl. the projection quartet, YOLO backstop, unmapped-forced-ask, scheduler/admin/destructive, family rail hit, inline-scheduled, attachment_open birthright) yields exactly today's tuple under an answering judge AND under an `Unavailable` judge for each of the six codes + `wiring_missing` (the offline column differs only where AF-AC5 says: interactive auto asks, reason line set). Test titles are the required leaf ids verbatim.
- T6-AC6: AGGREGATION + GATES. The AF-AC8 aggregation run executes S1–S6 + TB1–TB4 + mirrors in one `it` and reports the tap total per lane (no earlier-owned test edited). Existing unit and Postgres suites pass; tsc and check:architecture green; ceilings: `ipc-permission-classifier-decision.ts` ≤ 700, `inline-agent-loop-tools.ts` ≤ 750, `permission-classifier.ts` ≤ 700, `ipc-interaction-processing.ts` ≤ 865 (untouched), 700 elsewhere; no wrapper, shim, alias or compatibility naming.

## Technical Approach
1. The latch is a pure application module with the two copy strings; runtime callers import it (rejected: a runtime module beside the IPC tail — both ceilings are within 10 lines, and application is importable from both paths).
2. Each caller sends the notice through its already-injected `sendMessage` port right before the card, keyed by request fields it already holds (rejected: hooking `channels/permission-approval-requester.ts` — adapters layer, no classifier status; hooking `durable-interaction-handler.ts` — shared with callers that never consulted the judge).
3. `wiring_missing` is a failure code, not a status; the callers reuse the `failedResult` shape so the latch sees one `Unavailable` kind (T2a-AC3).
4. The invariance suite reuses the harness and copies expected tuples verbatim; its only new column is the `Unavailable` stub (rejected: new fixtures per lane — the harness already drives the real `resolvePermissionIpcDecision`).

## Decisions
0154, 0153, 0121→0156 (jobs walk the chat ladder), 0043, 0052. No new decision (owner ruling recorded in the story plan; the process-local choice is recorded as an assumption at pr-ready).

## Surface Impact
When the judge is down, a DM or group gets one plain sentence, then the usual card whose reason says why; nothing else changes. Reads the rails already allow stay silent; a remembered Allow keeps working.

## Task Decomposition
Single task; depends on T4 and T5b (both merged). Write scope (≈13 files): source — NEW `apps/core/src/application/permissions/permission-judge-outage-latch.ts`, `apps/core/src/runtime/permission-classifier.ts`, `apps/core/src/runtime/ipc-permission-classifier-decision.ts`, `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts`; tests — NEW `apps/core/test/unit/application/permission-judge-outage-latch.test.ts`, `apps/core/test/unit/runtime/ipc-permission-classifier-decision.test.ts`, `apps/core/test/unit/bootstrap/inline-agent-loop-tools.test.ts`, `apps/core/test/unit/runtime/permission-classifier.test.ts` (wiring_missing mapping), NEW `apps/core/test/unit/runtime/askfloor-invariance.test.ts`, `apps/core/test/unit/runtime/askfloor-tap-budget.test.ts`, `apps/core/test/unit/runtime/askfloor-tap-budget-harness.ts`. Budget 13 files / 1,200 lines. `user_facing: true` → functional check before pr-ready (emil-design-eng + frontend-design in skills_used for the copy).

## Risks
- Reviewer contract drift (T5b lesson): every clause above names its owner layer and the exact seam; the grill must check each against `architecture-map.json` before recording.
- The inline `beforePrompt` also runs for non-classifier asks (setup pause, core tools): the notice is gated on the consult result being `Unavailable`, so those never notify.
- Two runtimes (rare) → one duplicate notice; accepted by the owner ruling.
- Codex thread size: ≈13 files fits one run if the brief is sliced (latch + IPC hook, then inline hook, then suites). Ledger the slicing lesson BEFORE the first delegate; run the Postgres lane host-side.

## Manual Verification (functional check, user_facing)
1. Make the judge unavailable (unset the classifier model in the runtime settings → `llm_unconfigured`), DM the agent a non-read-only request in interactive auto: one notice sentence, then the card with "Asking because my safety judge is offline."; a second request: card only.
2. Tap Allow with remember; repeat the identical request: no card. `/permissions` lists the row.
3. A read inside the workspace: no notice, no card.
4. Restore the judge; send a request that the judge answers; then break it again: the notice appears once more.
5. Group route: same sequence, one notice per group conversation.

## Verify Plan
`python3 factory/scripts/verify.py` with `GANTRY_TEST_DATABASE_URL`; `npx tsc --noEmit`; `npm run check:architecture`; the new and touched unit suites through `vitest.unit.config.ts`; the AF-AC8 aggregation `it` prints the per-lane tap totals.

## Workflow
```mermaid
flowchart LR
  A[consult result] -->|Unavailable| B[latch.observe(app, account, conversation)]
  B -->|noticeDue| C[sendMessage: one notice]
  C --> D[card with offline reason]
  A -->|Answered| E[latch.reset]
  A -->|Skipped / read-only gate| F[unchanged today]
```


## What to return

Findings only: contradictions, gaps, unstated assumptions, and anything a reader would have to guess. Say what would break and why. Do not record a gate — the coordinating session records it.

The round count below is a FLOOR, not a target. Keep grilling until a round comes back clean AND stays clean on the next one — hitting the floor is not the same as passing.
