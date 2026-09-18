# Cold-read grill — gate: task — task plan LOCAL-DEV-1-T1

You did NOT write what follows. Read it cold, as an adversary trying to break the handover, never as its author defending it. You are READ-ONLY: return findings, change nothing.

## Interrogation technique

Run the interrogation this way. The harness contract above is the floor; this is the technique.

---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.


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
- When replacing Postgres runtime schema in one cut, move active runtime persistence behind canonical Drizzle repositories/services in the same change; leaving schema-owned raw SQL or old table definitions creates drift and runtime failures after destructive migrations.
- Keep provider-specific and channel-specific behavior behind adapters; domain and application code should depend on stable product concepts and ports, not SDK payloads or runtime wiring.
- Risky tool execution must pass through deterministic permission evaluation and sandbox policy before any provider callback or runner grants access.
- Fleet compose rehearsal must run settings-seed through the normal Docker entrypoint so local auto-secrets are exported, and seed desired-state via the import service rather than the broad CLI bootstrap; the CLI bootstrap can close the shared runtime storage pool before settings import validation finishes. Docker-internal first-party Postgres hostnames need explicit plaintext allowance while real remote Postgres still requires sslmode=require.
- Run the focused Prettier check after adding or reshaping TypeScript tests so the deterministic structural gate does not rediscover formatting drift.
- The full npm run test:unit lane can finish the LIVE-1 surfaces and then remain silent without a Vitest summary in this checkout; do not call it green without the exit code, and preserve focused lane evidence separately.
- Managed command policy can reject required VITEST_JUNIT/FORGE_TEST_ID commands when the exact testcase identifier contains a literal greater-than separator. Report the wrapper lane as blocked and do not call it passing.
- Managed command policy can refuse the required FORGE_TEST_ID when its exact test name contains a greater-than character; report the policy refusal separately from focused test evidence.
- A jobs or runner directory-wide Vitest invocation can remain live without a summary or exit code in the managed environment; terminate it after bounded polling and report it as unverified, not green.
- A focused Vitest selector can complete its test but still exit 1 when the macOS watcher hits EMFILE; treat this as blocked verification and rerun with the canonical wrapper or a watcher-safe environment.
- Postgres JSONB normalizes object key order and drops undefined; any equality check against persisted state (JSON.stringify ===) silently fails in prod while structuredClone-based fakes keep it green. Compare with util.isDeepStrictEqual and make repository fakes persist through a JSONB-faithful round trip (see test/unit/application/jsonb-round-trip.ts).
- The stage review budget counts a git rename as two files (old path deleted plus new path added): a 39-file folder move measured 95 files against a budget of 62. Size max_changed_files for move/refactor tasks as 2x renames plus edits, with the reason on the record.
- Managed execution can reject a required test when an inline environment assignment is the command prefix, reporting that the shell wrapper hides prefix inspection; invoke the same command through env so the executable prefix is visible, and report any remaining refusal separately.
- On a task touching 20+ files the Codex run hits the compaction limit after about 90 read commands; the source files are already complete and committed (checkpoint 5e060951a, tsc clean), so do NOT re-read finished source files — start from git status and the required_tests list, write or finish ONE test file at a time (run only that file with vitest), and stop reading the brief's cited source lines you have already implemented.
- Remaining T2b work after the checkpoint is ONLY: (1) test/unit/runner/tool-permission-gate.test.ts:1347-1358 — re-point the CAPSAFE-1-BOUNDARY import from the deleted gantryToolDefaultRisk to gantryToolRisk and assert capability_run is high; (2) test/unit/runtime/permission-classifier.test.ts — replace the 'auto-approves a routine gantry mutation via the deterministic map' expectation (medium is gone) and make the lane-independent-high leaf pass (the consult stub must not be invoked for a table-judged tool); (3) create test/unit/runtime/browser-file-attach-source.test.ts; (4) the remaining required_tests leaves in ipc-permission-classifier-decision, ipc-file-artifact-handlers, file-tool and askfloor-tap-budget. Source files are complete and committed; do not re-read them.
- Exactly six required leaves are still missing; every source file and every other suite is complete, committed and green (tsc clean). Write ONLY these six it() titles verbatim, one file at a time, running only that file after each: - apps/core/test/unit/jobs/ipc-file-artifact-handlers.test.ts: it('hides protected entries from list with a protectedHidden count and refuses a protected read by id and by path with the fixed not-a-permission-question text') - apps/core/test/unit/runner/mcp/file-tool.test.ts: it('appends the protected-entries-hidden line to list output only when the count is positive and relays a protected read refusal unchanged') - apps/core/test/unit/runner/tool-permission-gate.test.ts: it('keeps capability_run high through the typed table for the CAPSAFE-1 boundary with no classifier-derived or cached allow') - apps/core/test/unit/runtime/askfloor-tap-budget.test.ts: it('TB1 TB2 TB3 TB4: a browser click, a file read by path, an unprotected file write and a native FileWrite inside the workspace cost 0 taps in interactive auto with the LLM consult not invoked') - apps/core/test/unit/runtime/askfloor-tap-budget.test.ts: it('mirror fixtures: a protected file write, a FileWrite outside the workspace and scheduler_delete_job cost 1 tap, and a raw-path file_attach reaches the stubbed LLM consult as ambiguous') - apps/core/test/unit/runtime/askfloor-tap-budget.test.ts: it('keeps today's outcome for the TB1 TB2 TB3 TB4 fixtures under auto_strict, ask and autonomous')
- T3a order that fits one Codex run: (1) schema.ts + port + repository + domain/types.ts + the shared boundary canonicalPath, then run npm run db:migrations:generate -- --name permission_decision_memory_human (NEVER hand-write the SQL or snapshot; commit what drizzle-kit emits), then npx tsc --noEmit; (2) the scope-key module and the service; (3) tests ONE FILE AT A TIME in this order — provenance, scope, service, prospective-write pin, Postgres suite — running each file right after writing it and never re-reading a finished source file. Postgres tests need the TEST database: run 'source /private/tmp/claude-501/-Users-ravikiranvemula-Workdir-myclaw/b4051e43-dbea-4d62-ba73-ae6210455474/scratchpad/pgfix-env.sh' in the same shell before vitest (it exports GANTRY_TEST_DATABASE_URL for gantry_test; the live database gantry must never be touched). Required leaf titles are exact it() names from the brief.
- The tree already holds partial T5b work (listing module, forget handler, parser, ports, four provider branches). Do NOT re-survey: read only the cited line ranges in the brief and the files you are about to edit. Order: 1 listing module + parser + session command; 2 forget handler + wiring setter + runtime-services bind; 3 audit read port + Postgres adapter + job-name hydration; 4 label carrier on both prompt paths + guidance line; 5 the four provider in-place edits; 6 tests one file at a time, running only the touched suite after each. Everything you write survives on disk across relaunches; commit nothing, finish the slice in front of you.
- Every source file in the T5b scope is already edited, type-checks clean, and is committed. Do not re-read or rework sources unless a test proves a defect. Remaining, one file at a time, running only that suite after each: unit/runtime/group-processing.test.ts, unit/runtime/permission-decision-coordinator.test.ts, unit/bootstrap/runtime-app.test.ts, unit/bootstrap/channel-message-action-router.test.ts, unit/application/human-decision-memory-service.test.ts, unit/runtime/ipc-interaction-handler.test.ts, unit/bootstrap/inline-agent-loop-tools.test.ts, unit/runtime/prompt-profile.test.ts, unit/channels/telegram.test.ts, unit/channels/slack.test.ts, unit/channels/discord/discord.test.ts, unit/channels/teams/teams.test.ts, then unit/runtime/askfloor-tap-budget-harness.ts + askfloor-tap-budget.test.ts (S5). Each required_tests leaf id must appear verbatim as a test title.
- cache-bug-T1 AC9/S11 is fulfilled by npm run lint:changed (ESLint over TypeScript files changed against the merge-base with origin/main) inside FACTORY_STRUCTURAL_CMD in .envrc and as the blocking CI step, with full npm run lint kept as an advisory continue-on-error CI step; the 82 pre-existing errors are recorded as deferral D-0080 and must NOT be fixed, baselined or suppressed in this task. This is the orchestrator's recorded ruling (signals S-0092, S-0095, S-0099, 2026-09-09): do not raise it again.
- Together with the three quality P2s these are the ONLY changes in this round: (4) the used-by lookup runs only for the rows actually rendered (the ten newest for bare /permissions, all for /permissions all), never for every remembered record; (5) job-name hydration is ONE batched read for the collected job ids, not a serial per-record loop; (6) a provider in-place edit failure must never suppress the Forget receipt — send the confirmation reply first or independently, then attempt the edit, and pin it with a test per provider where the edit throws; (7) keep behaviour otherwise identical. Run only the touched suites; tsc and check:architecture stay green.
- Final fix cycle; change nothing else. (1) After a Forget tap the re-rendered list hydrates used-by ONLY for the rows it renders (the ten newest), same as the bare listing. (2) Job-name hydration is ONE bulk repository read for the deduplicated job ids (a single list/getMany call), not concurrent per-id reads — this also bounds /permissions all to one query. (3) Slack: when the replacement view has no buttons, clear the blocks (send an empty blocks array / text-only update) so stale buttons do not linger; pin with a test. (4) Move the 'Already forgotten.' string into the listing copy owner beside the other replies. Run only the touched suites; tsc and check:architecture stay green.
- Everything else is committed and green. The only failing test is 'lists one latest use per job by human decision record id…' in the Postgres suite: the adapter's listDecisionsByHumanDecisionRecordId returns lastUsedAt as the raw Postgres text ('2026-09-04 00:00:00+00') while the port promises an ISO string ('2026-09-04T00:00:00.000Z'). Fix it in adapters/storage/postgres/repositories/domain-repositories.postgres.ts by normalising the value the way the sibling reads in that file do (e.g. new Date(value).toISOString() or the existing timestamp helper); do not change the test's expectation. You cannot reach Postgres from your sandbox — the orchestrator runs that suite; just make the change, run tsc, and finish.
- The review marked two contracts partial; close them and nothing else. (AC2) PermissionMemoryListMessageView and the list-view type live in application/permissions/permission-memory-listing.ts (the required owner) — move the type there and import it from the current location; no behaviour change. (AC5) the used-by read fetches ONLY the job ids referenced by the rendered records: collect the ids from the rows being rendered, dedupe once, and pass exactly that set to the single bulk job read; add a listing test asserting the bulk read receives only referenced ids. Run listing + forget-handler suites, tsc, check:architecture; ceilings measured after prettier.
- Orchestrator ruling (signals S-0093 and S-0094 resolved): PermissionMemoryListMessageView is DOMAIN-owned by design and stays where it is; AC2's 'listing module owns the view type' clause is superseded by the layer rule (domain must not import application) and is considered implemented. Do NOT move the type, do NOT raise a contradiction about it, do NOT edit domain/message-actions.ts. The single remaining change is AC5: in application/permissions/permission-memory-listing.ts (or the forget handler where hydration is called) collect the job ids referenced by the rows being rendered, dedupe once, and pass exactly that set to the one bulk job read; add a listing unit test asserting the bulk read receives only the referenced ids. Run the listing and forget-handler suites, tsc, check:architecture; finish.
- Exactly these changes, nothing else. (P1, blocking) app/bootstrap/runtime-services.ts ~line 601: the Forget handler's resolvePerson must canonicalise the caller in the CONVERSATION's app — derive the app id with appIdFromConversationJid(action.conversationJid) (the same value the handler later uses for the memory lookup) and pass it to resolveCanonicalMemoryPersonId instead of the process-wide runtime app id; pin with a runtime-services test where the conversation's app differs from the process app. (AC5) runtime-services.ts ~626 and app/bootstrap/group-processor-deps.ts ~87 bind a job reader that ignores the id set and lists ALL jobs; bind a by-ids read (add listJobsByIds(appId, ids) to the ops job repository port + Postgres adapter if none exists, or batch the existing getJobById) so only the referenced ids are read; pin it. (AC2) application/permissions/permission-memory-listing.ts ~155 duplicates the category-noun table; delete it and call the existing shared category-noun helper the card copy uses; add the one-job and two-job used-by cases to the listing suite beside the 3+ case. Run runtime-services, listing, forget-handler suites; tsc; check:architecture; ceilings after prettier (runtime-services ≤ 1186). You cannot reach Postgres; the orchestrator runs that lane.
- Orchestrator ruling (S-0095 resolved): do NOT add listJobsByIds or touch ops-repo.ts / the jobs Postgres adapter (out of scope). AC5 is implemented by: collect the job ids referenced by the rows being rendered (≤10 for bare /permissions; all active rows for /permissions all), dedupe once, and resolve names with ONE concurrent batch — Promise.all over getJobById for exactly that set — in the reader bound at runtime-services.ts ~626 and group-processor-deps.ts ~87; never list every job. Pin with a listing test that the reader is invoked only with the referenced ids. Do not raise a contradiction about this. Then: (P1) runtime-services.ts ~601 pass appIdFromConversationJid(action.conversationJid) into resolveCanonicalMemoryPersonId (test: conversation app ≠ process app); (AC2) delete the duplicate category-noun table at permission-memory-listing.ts ~155 and call the shared helper; add the one-job and two-job used-by cases. Run runtime-services, listing, forget-handler suites, tsc, check:architecture; ceilings after prettier.
- Orchestrator ruling (S-0097 resolved, AC2 amended): permission-memory-listing.ts OWNS the category-noun mapping (CATEGORY_NOUNS + exported permissionMemoryScopeNoun). No other noun helper exists; do not search for one, do not delete the table, do not raise a contradiction about nouns. Do exactly three things and finish: (1) P1 — runtime-services.ts ~601: pass appIdFromConversationJid(action.conversationJid) into resolveCanonicalMemoryPersonId; add a runtime-services test where the conversation's app differs from the process app. (2) AC5 — in the readers bound at runtime-services.ts ~626 and group-processor-deps.ts ~87, resolve names with one Promise.all over getJobById for the deduplicated referenced ids only (never list all jobs); test that only referenced ids are read. (3) AC5 tests — add one-job and two-job used-by cases in permission-memory-listing.test.ts beside the 3+ case. Run runtime-services, listing, forget-handler suites; tsc; check:architecture; ceilings after prettier.
- Orchestrator ruling (review round 6): MemoryForgetMessageActionInput carries the agent identity as the bounded agentRouteKey — the codec key the round-3 grill ruled because Telegram's callback payload is size-limited; the host handler resolves the route-effective agentId from it. Do NOT add an agentId field to the domain input or to any provider payload; AC4 has been amended to say so. Do not raise a contradiction about it. The single remaining change: app/bootstrap/runtime-services.ts ~line 631 — the post-Forget used-by hydration (and any used-by read the Forget handler performs) must use the CONVERSATION's app id (appIdFromConversationJid(action.conversationJid), the same value the handler already uses for the memory lookup and the person resolver), never the process-wide app id; pin it with a runtime-services test where the conversation app differs from the process app. Run runtime-services + forget-handler suites, tsc, check:architecture; ceilings after prettier (runtime-services ≤ 1186 — extract a tiny helper if needed). Finish.
- Work in this order and finish each slice before reading further; everything you write survives on disk across relaunches; commit nothing. Slice 1: NEW application/permissions/permission-judge-outage-latch.ts (pure latch: observe/reset/clearAll, keyed appId|providerAccountId|targetJid, the two exported copy strings) + NEW runtime/permission-judge-outage.ts (module-level judgeOutageLatch instance, unavailablePromptConsultResult(failureCode, startedAt) returning the full PermissionClassifierPromptConsultResult with decision 'ask', isJudgeUnavailable, sendJudgeOfflineNotice with { threadId, providerAccountId }, no-target skip, swallowed errors) + add 'wiring_missing' to the failure-code union at runtime/permission-classifier.ts:60. Slice 2: IPC — split eligibility from wiring at ipc-permission-classifier-decision.ts:361, synthetic result on wiring failure, notice call before requestPermissionApproval at :639 and :595 and before the terminal job decision, reason line, exclude Unavailable from the cache write at :502; the file is 691/700 — calls only; extract the verdict-cache helpers into the runtime glue module if needed. Slice 3: inline-agent-loop-tools.ts — split the :372 guard, notice in beforePrompt (:449-468) and before the scheduled cancel return at :410, reason line; 708/750. Slice 4: NEW latch suite, NEW glue suite, the wiring_missing case in permission-classifier.test.ts, the IPC-decision cases, the inline cases — one file at a time, run only that suite. Slice 5: harness knobs (classifierVerdict.status, sendMessage + publishRuntimeEvent spies returned from replayPermissionRequest, classifierConsult param on replayExactMemorySequence), S6 + aggregation in askfloor-tap-budget.test.ts, NEW askfloor-invariance.test.ts as an it.each table over harness fixtures with tuples copied verbatim. Test titles = required_tests ids VERBATIM. You cannot reach Postgres; the orchestrator runs that lane. Never list all jobs, never import channels/.
- Exactly six changes; product design is otherwise final. (1) inline-agent-loop-tools.ts ~422: call observeJudgeAvailabilityForRequest BEFORE the successful-allow return so an answered allow clears the latch (pin: answered allow then unavailable → notice again). (2) askfloor-tap-budget.test.ts S6 ~324: the uncovered-read case must be a READ that the rails do not cover (e.g. a file read by path OUTSIDE the trusted root, or an mcp read binding not in reviewedMcpReadBindings) — not mcp__crm__update_record — and must assert exactly one tap and one notice; add the scheduled-job case (hostJobId set, judge unavailable): notice sent once to the job conversation, decision reason = JUDGE_OFFLINE_REASON, deterministic denial + card recovery unchanged. (3) askfloor-invariance.test.ts: build the matrix from the REAL harness fixtures — one row per lane in AF-AC6: ask, auto_strict, interactive auto, trusted-host autonomous via registerWorkerPermissionRunRestriction, the projection quartet via replayRememberedJobProjection (exact match allows, near-miss cards, revoked re-cards, rails-bump re-cards — the harness has these), YOLO backstop, unmapped forced ask, scheduler_delete_job, destructive via replayDestructiveExactMemory, the family rail hit asserting FAMILY_RULE_RAIL_HIT_REASON, the inline-scheduled path through the INLINE gate (pattern of inline-agent-loop-tools.test.ts:1115/1450, not the IPC replay), attachment_open via attachmentOpenIds; expected tuples copied verbatim from askfloor-tap-budget.test.ts:26/173/233 and ipc-permission-classifier-decision.test.ts:360/385/416; the Unavailable column for the six codes + wiring_missing differs only where AF-AC5/0157 say. (4) aggregation ~356: actually run the four TB1-TB4 interactive-auto fixtures and the four mirrors (protected write, outside-workspace write, scheduler_delete_job, raw-path attach) plus S1-S6 through replayPermissionRequest and sum taps per lane. (5) runtime/permission-judge-outage.ts:133: delete the unused exported sendJudgeOfflineNotice; keep only sendJudgeOfflineNoticeForRequest and test that one. (6) REGRESSION apps/core/test/unit/application/jobperm-ask-and-wait.test.ts 'denies a job request when its permission card cannot be attached' now fails (attachRequest 0 calls): on a job lane a synthetic wiring_missing result must flow into the SAME card/attach path as a real classifier ask (0157), never a terminal decision before attach — fix the IPC resolver so that test passes unchanged. Test titles must stay the required_tests ids verbatim. Run the touched suites + that jobperm suite; tsc; check:architecture; ceilings after prettier.

## The contract as recorded (authoritative over any copy in the plan)

## Contract (recorded)

Rendered by the harness from the recorded decomposition; edit the decomposition, not this block. It is excluded from the plan's approval and grill digests, so a re-render never stales either.

**Objective.** Finish the promoted Full Forge local-dev story as a single backend/CLI tooling task: close the destructive-safety, authority, recovery, TTY-safety, and orphan-hardening gaps found by the spec/requirements/plan grills while preserving the already-landed Lite start/stop/dev behavior, and land the narrow architecture exception plus PR-ready proof.

**Acceptance criteria**

- `npm run dev` builds contracts and routes to `gantry local start`; `npm run dev:stop`, `npm run reset`, and `npm run reset:db` route to their local CLI commands; `npm run dev:core` remains the core-only source command.
- `npm run build:core` builds backend artifacts only (contracts, SDK, core `tsc`, migrations copy, CLI executable bit), composed from the same steps `build:runtime` already uses; `npm run build:runtime` and `npm run build` produce the same `dist/` output as today.
- `README.md` documents the full build-command set (`build:contracts`/`build:sdk`/`build:web`/`build:core`/`build:runtime`/`build`) and its separation from the dev/local commands, and drops any obsolete explicit-only authorization guidance — resolving the `plan-contract-partial` recurring-finding class for this story's documentation surface.
- `gantry local start|reset|reset-db|stop` are visible in top-level CLI help and dispatch through `apps/core/src/cli/local.ts` without forcing normal settings parsing before local bootstrap; `gantry local` with no subcommand prints usage and starts nothing; `local status`/`local doctor` no longer exist as duplicates of the top-level commands.
- Source-local startup validates Node 24 and source checkout, resolves runtime home with precedence `--runtime-home` > `GANTRY_HOME` > `<repo>/.gantry`, creates missing private `.env` defaults, and preserves existing values.
- Every destructive or mutating step (database reset, filesystem reset, migration, container start) is preceded by home safety, Node version, database-target authority (via a reversible bootstrap-then-check against the authoritative Postgres settings revision per decision 0025), and authentication-mode authority checks; a failed check leaves existing state and running children untouched — no partial reset, no stopped/started children.
- A genuinely fresh runtime home gets a Gantry-written ownership marker at the moment of first bootstrap, never retroactively; filesystem reset refuses on any home without one, with a manual remediation, not an automatic adoption path. Database reset refuses unless the target is the exact verified home-owned managed Postgres container's endpoint (the same check `local stop` already performs), never merely "a reachable loopback database named `gantry`", and refuses a non-default `GANTRY_DATABASE_URL` for reset outright.
- Source-local startup refuses, before touching the database or filesystem, when the authoritative settings (latest Postgres revision, or `settings.yaml` for a genuinely fresh home) declare a non-default `storage.postgres.url_env` or `.schema`, or when `GANTRY_SETTINGS_POSTGRES_SCHEMA`/a URL `schema=` param/`GANTRY_DB_SCHEMA` would redirect migrations elsewhere, naming the conflict and how to align it.
- A reset that crashes after the database schema commit but before filesystem cleanup finishes leaves a durable marker naming the interrupted variant; the next start/reset/reset-db refuses with a clear message instead of starting against mixed old/new state, lifted only by an explicit `--after-manual-recovery` flag after the operator inspects local state.
- Local startup validates a loopback control origin, creates or verifies authentication `canonicalOrigin`, runs migrations before starting source core and Vite, proxies browser auth/API traffic through Vite, and prints the stable UI URL only after health is ready (the proxied `/healthz`, not `/readyz`).
- Local DB handling reuses a reachable loopback DB, starts Compose only for the verified home-owned default Postgres container, refuses unreachable custom DBs, and refuses foreign `gantry-postgres` containers.
- `gantry local stop` stops source core and Vite through the local supervisor socket and stops only the verified home-owned managed Postgres container; custom Postgres is left alone; stop refuses to stop that container while an orphaned core process still holds an active database connection after this invocation's own children are shut down.
- Reset commands run every precondition before stopping any verified local children, refuse unsafe homes, non-loopback/non-`gantry` reset targets, and any home/database that fails ownership verification, recreate only `gantry` and `pgboss` under the reset-in-progress marker, preserve `.env`, `postgres/`, unknown files, and unrelated processes, then restart through the same healthy-start path.
- `reset-db` writes the just-validated authoritative settings revision out to `settings.yaml` (the matching recovery copy) before dropping `settings_revisions`, so a post-reset restart reflects the same desired configuration instead of stale/default YAML.
- Every successful start/reset first confirms `authentication.mode` is `local` and the public origin is loopback, then attempts (mandatory-attempt, fail-open) a fresh one-time authorization link via the same in-process issuance path `gantry ui authorize` uses after readiness — the raw URL only on an interactive TTY, otherwise the stable UI URL plus a `--runtime-home`-inclusive retry command and never the raw token; a failed issuance for any reason leaves the healthy dev stack running.
- `gantry local stop` (and the next `local start`'s preflight) detects and terminates a leftover orphaned Vite process via a recorded PID file, even after the supervisor itself previously crashed.
- Existing sessions remain valid after a restart or a freshly issued link without a reset; `reset`/`reset-db` end all sessions by design. Manual verification proves restart-session-survival without storing raw URLs or tokens in artifacts.
- `python3 scripts/check_architecture.py` passes because `scripts/architecture-exceptions.json` contains a single, time-bounded `direct_risky_execution` exception for `apps/core/src/cli/local.ts`, capped to the current direct spawn count only.
- Full Forge closeout runs required focused tests, deterministic verify, one autoreview pass across quality/performance/security, records evidence, and raises the PR.

**Write scope** (what `stage done` measures the diff against)

- package.json
- apps/core/src/cli/index.ts
- apps/core/src/cli/local.ts
- apps/core/src/cli/local-postgres.ts
- apps/web/vite.config.ts
- apps/core/test/unit/cli/index-local-routing.test.ts
- apps/core/test/unit/cli/local-postgres.test.ts
- scripts/architecture-exceptions.json
- README.md
- docs/architecture/overview.md
- docs/SPEC.md
- apps/core/src/adapters/storage/postgres/storage-readiness.ts
- plans/roadmap.json

**Required tests** (run by `stage done`)

- `bare gantry local prints usage and starts nothing` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `local status and local doctor no longer exist as duplicate commands` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `filesystem reset refuses a runtime home with no ownership marker` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `full reset rewrites the ownership marker only on an already-marked home` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database reset refuses a non-default GANTRY_DATABASE_URL outright` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database reset refuses a reachable custom database coincidentally named gantry` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `reset preconditions run before any already-running child is stopped` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database-target authority refuses a conflicting storage.postgres.schema before any destructive step` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authentication-mode authority refuses before any child process starts` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `a stale reset-in-progress marker refuses and names the interrupted variant` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `a stale reset-in-progress marker is cleared only by --after-manual-recovery` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `reset-db writes the validated settings revision to settings.yaml before dropping settings_revisions` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `stop refuses to stop Postgres while an orphaned core connection remains` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `stop detects and terminates a leftover orphaned Vite process via the recorded PID file` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authorization link prints the raw URL only on an interactive TTY` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authorization issuance failure leaves the healthy dev stack running` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `IPv6 bracketed control host is normalized before binding` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `ownedPostgres verifies the container's published host and port binding` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)
- `ownedPostgres is called unconditionally before any reset` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)
- `pg_stat_activity check reports any active database client, not only core` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)

**Verify commands**

- `npm run test:unit -- apps/core/test/unit/cli/index-local-routing.test.ts apps/core/test/unit/cli/local-postgres.test.ts`
- `npm run format:check`
- `npm run format:check:web`
- `npm run typecheck`
- `npm run build:core`
- `npm run build`
- `python3 scripts/check_architecture.py`
- `python3 factory/scripts/verify.py`

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
- Q: Which change should the artifact reflect?
  A: The new task-level loop from PR 443 (story → tasks → task plan in plan mode → task grill)
- Q: If the job card itself can't be created for a request (DB down, no group route), what should the run get?
  A: Deny the tool call with a plain reason (Recommended)
- Q: Anything else to settle for JOBPERM-2 before I confirm the spec and plan it?
  A: No — confirm and plan (Recommended)
- Q: Should attaching a skill remain separate from authorizing its declared actions?
  A: Keep separate (Recommended)
- Q: The independent cold read found no contradictions. Is the current Skills UI spec ready to confirm?
  A: Confirm spec (Recommended)
- Q: Reviewers want a ~2-minute demo right after the problem statement. What anchor can you actually deliver on stage?
  A: Live Telegram demo (Recommended)
- Q: Srix: title and talk didn't match; the strong anchor is "OpenClaw, but for the org". What's the new title direction?
  A: OpenClaw-anchored (Recommended)
- Q: Where do I build the rewritten deck?
  A: Update same design canvas (Recommended)
- Q: Should re-enabling a disabled provider preserve omitted stored fields through the existing sparse PATCH flow?
  A: Preserve via PATCH (Recommended)
- Q: Should first setup prevent saving or constructing a request until a multi-method provider’s authentication method is explicitly selected?
  A: Require selection (Recommended)
- Q: gantry local reset only checks the target DB is loopback + named `gantry`/schema `gantry` — it never verifies the DB or home directory was actually created by Gantry. A coincidentally-named local Postgres or directory from an unrelated project could get destroyed. How should this PR handle it?
  A: Add ownership checks now (Recommended)
- Q: core can read its real Postgres URL/schema from settings.yaml (storage.postgres.urlEnv/schema), which can differ from the hardcoded GANTRY_DATABASE_URL/`gantry` the supervisor resets and migrates. Also, `gantry ui authorize` only works when authentication.mode is 'local', but startup never checks that before trying to issue a link. Fix now or defer?
  A: Enforce local-mode defaults now (Recommended)
- Q: Smaller confirmed gaps: the authorization retry message omits the resolved --runtime-home flag (so retrying can target the wrong home), and there's an IPv6 literal-bracket bug in host handling. Both are one-file, low-risk fixes inside the existing local.ts scope. Fix now or defer?
  A: Fix now, same write scope (Recommended)
- Q: Automated tests mock Postgres/Docker/processes entirely — they don't exercise a real stop/restart/reset cycle or prove existing browser sessions survive a new auth link. The plan already calls for manual disposable-state verification to cover that gap. Is that sufficient for this PR?
  A: Keep mocked unit tests + my manual verification (Recommended)
- Q: Separately from ownership verification: reset commits the DB schema drop before filesystem deletion/migration with no cross-home lock (a crash mid-reset leaves a half-reset state), and a killed supervisor can leave orphaned core/Vite children running while `stop` still stops Postgres underneath them. Should this PR also reorder reset to preflight-then-destroy and detect orphaned children before stopping Postgres, or record this as deferred hardening?
  A: Harden ordering + orphan detection now (Recommended)
- Q: That covers every finding from the cold-read grill. Any remaining gap before I amend the spec to what you've decided and move to the plan gate?
  A: No — proceed to amend and record the grill pass (Recommended)
- Q: Two consecutive Codex cold-read attempts for the LOCAL-DEV-1 requirements gate stalled for 30+ minutes each inside the shared codex app-server process (the same process also serving your ChatGPT desktop app), producing zero output before I had to stop them. This tripped the harness's 2-attempt escalation cap. How would you like to proceed?
  A: Retry once more now (Recommended)
- Q: Decision 0025 makes the Postgres settings_revisions table authoritative over settings.yaml, but reading it requires Postgres to be up — while the spec also says nothing destructive/mutating runs before authority checks pass. How should startup resolve this chicken-and-egg?
  A: Reversible bootstrap-then-check (Recommended)
- Q: The implementation exposes undocumented `local status`/`local doctor` (duplicating existing top-level `gantry status`/`gantry doctor`), and bare `gantry local` silently starts the whole dev stack instead of doing nothing. Fix this CLI surface now?
  A: Remove duplicates, bare command prints usage (Recommended)
- Q: The one-time authorization link is a 10-minute admin credential. Right now it always prints to inherited stdout, so shell redirection, IDE task logs, or CI capture could persist it — contradicting the no-token-in-evidence rule.
  A: TTY-gate the raw URL (Recommended)
- Q: Preflight-then-destroy ordering (already decided) prevents refusal-after-partial-mutation, but does nothing for a crash that happens AFTER the DB schema commit and BEFORE filesystem cleanup finishes — that leaves mixed old/new state with no way to detect or resume it.
  A: Add a durable reset-in-progress marker now (Recommended)
- Q: That's everything from this cold read plus the repo-answerable fixes I'll make myself (settings-authority check via the DB revision not just YAML, the correct snake_case settings key, narrowing the session-preservation criterion to exclude reset, removing the decision-0003-violating retroactive ownership marker, binding reset to the exact managed endpoint, covering the extra schema-override env vars, reusing the DB active-connection check for orphan detection instead of a public health probe, fixing reset's stop-before-preflight ordering, and registering the deferred items with `forge defer add`). Any remaining gap before I amend the spec/plan and record this gate?
  A: No — proceed to amend and record (Recommended)
- Q: The current staged diff is already 1,646 additions across eight files before the remaining destructive-safety work, and the sole task covers roughly twenty distinct proof seams — too large for one bounded task/PR.
  A: Keep one task with an explicit size budget
- Q: The cold-read requirements grill found the reset-in-progress marker's remediation ("rerun the same reset command") deterministically refuses again on a genuine crash, since the marker never clears itself and the command has no way to know the operator already checked the state by hand. How should recovery actually work?
  A: Explicit operator acknowledgment flag (Recommended)
- Q: The grill found the orphan-hardening requirement is only partly met: the `pg_stat_activity` check catches an orphaned core process (it holds a DB connection) but not an orphaned Vite process, which is detached, holds no DB connection, and can keep squatting the UI port after a supervisor crash even though `local stop` reports success and stops Postgres. Close this gap now or accept it as a known limitation?
  A: Track child PIDs in a local file (Recommended)

## The artifact under interrogation (task plan LOCAL-DEV-1-T1)

# LOCAL-DEV-1-T1 — Full local source-dev supervisor closeout

## Objective

Close the destructive-safety, authority, recovery, TTY-safety, and
orphan-hardening gaps the spec/requirements/plan grills found in the
already-landed Lite `gantry local` implementation, add the narrow
architecture exception, and land PR-ready proof — as one bounded
backend/CLI task, per `plans/active/LOCAL-DEV-1-source-local-gantry-development.md`.

## Workflow

The end-to-end flow this task hardens is `gantry local <start|reset|reset-db|stop>`,
coordinated entirely by `apps/core/src/cli/local.ts`, with direct Postgres
inspection/reset calls moved into the new `apps/core/src/cli/local-postgres.ts`
(the bounded decision-0001 deviation). No new service layer, no new process.

```mermaid
flowchart TD
    A[gantry local start/reset/reset-db] --> B{Runtime home exists?}
    B -- no, fresh --> C[Bootstrap: create home, .env,\nownership marker (local-postgres.ts)]
    B -- yes --> D[Load existing home]
    C --> E[Reversible bootstrap-then-check:\nstart verified owned container]
    D --> E
    E --> F{Read latest settings revision\n(local-postgres.ts, min_reader_version fence)}
    F -- no revision, fresh DB --> G[Fall back to settings.yaml]
    F -- revision exists --> H[Validate storage + auth authority\nfrom SAME revision]
    G --> I{Authority checks pass?}
    H --> I
    I -- no --> J[Stop only a container THIS invocation started;\nleave existing state untouched; refuse]
    I -- yes --> K{Command is reset/reset-db?}
    K -- yes --> L[Write reset-in-progress marker\n(names variant)]
    L --> M[Write settings.yaml recovery copy\nfrom validated revision]
    M --> N[Stop already-running children\n(only now, after all checks)]
    N --> O[Drop/recreate gantry + pgboss schemas]
    O --> P[Clear reset-in-progress marker]
    K -- no (start) --> Q[Run migrations]
    P --> Q
    Q --> R[Start core + Vite, write PID file]
    R --> S[Wait for proxied /healthz]
    S --> T[Issue auth link in-process\n(TTY-gated, mandatory-attempt/fail-open)]
    T --> U[Print stable UI URL]

    V[gantry local stop] --> W[Stop core + Vite via PID file\n(detects orphaned Vite too)]
    W --> X{pg_stat_activity: any\nother active client?}
    X -- yes --> Y[Refuse to stop Postgres; report orphan]
    X -- no --> Z[Stop managed Postgres container]

    J -.->|stale marker on next run| AA[Refuse: name interrupted variant;\nrequire --after-manual-recovery]
```

## Scope

Write scope (existing files unless marked new):
`package.json`, `apps/core/src/cli/index.ts`, `apps/core/src/cli/local.ts`,
`apps/core/src/cli/local-postgres.ts` (new), `apps/web/vite.config.ts`,
`apps/core/test/unit/cli/index-local-routing.test.ts`,
`apps/core/test/unit/cli/local-postgres.test.ts` (new),
`scripts/architecture-exceptions.json`, `README.md`,
`docs/architecture/overview.md`, `docs/SPEC.md`,
`apps/core/src/adapters/storage/postgres/storage-readiness.ts`,
`plans/roadmap.json`.

No other new source files. `apps/core/src/cli/auth.ts` is deliberately NOT in
scope — the TTY-gated link is issued by calling the same in-process
authorization-issuance function `auth.ts` already uses, not by modifying it.

Size budget: target ceiling 2,000 added lines across the product-code/test
files above (README/docs/Forge evidence excluded); a run over that but under
4,000 lines is a NOTE at `stage done`, not a refusal; over 4,000 refuses and
pauses for a human scope decision.

## Key contract points (see the approved story plan for full detail)

- Ownership marker (`<home>/.gantry-owned`): written ONLY at first bootstrap
  of a genuinely new home; a full `reset` rewrites it only on an
  already-marked home; an unmarked home is refused with manual remediation.
- Database reset ownership: `ownedPostgres` (now in `local-postgres.ts`)
  called unconditionally before any reset, extended to verify the container's
  actual published host/port endpoint; a non-default `GANTRY_DATABASE_URL` is
  refused outright for reset.
- Settings authority: reversible bootstrap-then-check reads the latest
  revision with the canonical parser and `min_reader_version` fence (falling
  back to `settings.yaml` only when `settings_revisions` does not exist yet);
  storage AND authentication authority come from the SAME revision object.
- Reset-db/reset recovery copy: write the validated revision out as
  `settings.yaml` before the destructive schema step.
- Reset-in-progress marker: names the interrupted variant; cleared only by
  an explicit `--after-manual-recovery` flag, never a blind retry.
- TTY-gated, in-process auth-link issuance: raw URL only on an interactive
  TTY; otherwise the stable UI URL plus a `--runtime-home`-inclusive retry
  command; issuance is mandatory-attempt, fail-open.
- Orphan hardening: `pg_stat_activity` check (any active client, not just
  core) for `stop`'s Postgres refusal, plus a PID file for core+Vite so a
  leftover orphaned Vite process is detected and terminated even after a
  supervisor crash.
- CLI surface: remove `local status`/`local doctor`; bare `gantry local`
  prints usage; fix stale mentions of these removed commands in
  `docs/architecture/overview.md`, `docs/SPEC.md`, the recovery message in
  `storage-readiness.ts`, and the `plans/roadmap.json` session/link criterion.
- Architecture exception already on disk: `scripts/architecture-exceptions.json`
  already carries a count-exact, time-bounded `direct_risky_execution` entry
  for `local.ts`'s direct `spawn` calls (`maxViolations: 1`), landed with the
  prior Lite work — `check_architecture.py` currently passes. Confirm it
  still holds as this task lands; adjust only if a genuinely new
  risky-execution call site is introduced in `local.ts` itself (the
  `local-postgres.ts` extraction does not touch this — it moves persistence
  calls, not the `execFileSync('docker', ...)` spawn).
- `build:core` extracted from `build:runtime` per the plan; `README.md`
  documents the full build-command set.

## Required Tests

See the recorded decomposition's `required_tests` for the executable proof
list (20 vitest cases across `index-local-routing.test.ts` and the new
`local-postgres.test.ts`, covering CLI-surface reduction, ownership-marker
and database-reset refusals, preflight ordering, authority refusals, the
reset-in-progress marker and its `--after-manual-recovery` flag, the
recovery-copy write, orphan-core and orphan-Vite handling, TTY gating,
issuance-failure non-fatality, IPv6 normalization, and the `local-postgres.ts`
helpers themselves).

## Manual Verification

1. Use a disposable `--runtime-home` under a freshly created temporary
   directory and a disposable loopback Postgres target only; never touch
   real developer or production runtime data.
2. Start with the repo-built CLI (`npm run build:core` then the built
   binary, or `tsx` against the source entrypoint) against that temp home;
   confirm health, the stable UI URL, and that the authorization link
   prints only after readiness. Redact the URL in notes.
3. Redeem the first link in a browser, confirm the UI session works,
   restart, and confirm a new link is printed while the existing session
   remains valid.
4. Redeem the old link again (or after a new one issues) and confirm
   single-use behavior; record only pass/fail, never the token.
5. Run `gantry local stop`; confirm core/Vite stop and only the verified
   home-owned managed Postgres container stops. Repeat with a custom DB and
   confirm it is left running.
6. Run `gantry local reset-db` then `gantry local reset` against disposable
   state; confirm `.env`/`postgres/`/unknown files are preserved, the
   ownership marker survives `reset-db` and is rewritten fresh by `reset`,
   and `settings.yaml` reflects the validated revision after each.
7. Point `--runtime-home`/`GANTRY_DATABASE_URL` at a reachable custom
   loopback Postgres named `gantry` that is NOT the managed container;
   confirm `local reset` refuses it.
8. Set a conflicting `storage.postgres.schema`; confirm the database-target-
   authority refusal names the conflict before any destructive step.
   Separately, start core directly against the disposable DB (bypassing the
   supervisor) and confirm `local stop` refuses to stop Postgres, reporting
   the orphaned connection.
9. Kill only the Vite child via its recorded PID, then run `local stop` and
   confirm it detects and terminates the leftover process via the PID file.
10. Redirect a disposable authorization retry to a non-TTY sink and confirm
    the raw URL never appears there — only the stable UI URL and retry
    command.
11. Kill the process mid-`local reset` right after its database step
    (deterministic `kill -TERM` on disposable state, repo-built CLI, fresh
    temp parent directory); confirm the next command refuses, names the
    interrupted variant, that a blind rerun still refuses, and that
    `--after-manual-recovery` clears it and lets the same command proceed.

This manual pass against a real disposable Docker Postgres container
satisfies the repository's DB-backed-change verification requirement
(`docs/architecture/current-verification-commands.md`) without a new
automated integration-test lane, per the requirements grill's resolution:
the behavior under test is CLI/process lifecycle, not application-layer
database queries.

## Reviewer Focus

See the recorded decomposition's `reviewer_focus` field for the full list.
Highlights: the architecture exception must be count-exact and
operator-local only; the ownership marker must never be written to a
pre-existing unmarked home (decision 0003); `local-postgres.ts` must never be
imported by agent/tool/job code; every destructive step must be genuinely
preceded by its precondition checks, not merely reordered in appearance; no
raw authorization token may appear in any artifact; confirm the task diff
against the size budget.

## Design skills

This task is `user_facing: true` because its acceptance path includes a real
browser-session redemption, even though it ships no React component, style,
or motion change (only Vite proxy wiring). `emil-design-eng` and
`frontend-design` are loaded and attested in `skills_used` as
reviewed-with-no-visual-changes.

<!-- forge:contract -->
## Contract (recorded)

Rendered by the harness from the recorded decomposition; edit the decomposition, not this block. It is excluded from the plan's approval and grill digests, so a re-render never stales either.

**Objective.** Finish the promoted Full Forge local-dev story as a single backend/CLI tooling task: close the destructive-safety, authority, recovery, TTY-safety, and orphan-hardening gaps found by the spec/requirements/plan grills while preserving the already-landed Lite start/stop/dev behavior, and land the narrow architecture exception plus PR-ready proof.

**Acceptance criteria**

- `npm run dev` builds contracts and routes to `gantry local start`; `npm run dev:stop`, `npm run reset`, and `npm run reset:db` route to their local CLI commands; `npm run dev:core` remains the core-only source command.
- `npm run build:core` builds backend artifacts only (contracts, SDK, core `tsc`, migrations copy, CLI executable bit), composed from the same steps `build:runtime` already uses; `npm run build:runtime` and `npm run build` produce the same `dist/` output as today.
- `README.md` documents the full build-command set (`build:contracts`/`build:sdk`/`build:web`/`build:core`/`build:runtime`/`build`) and its separation from the dev/local commands, and drops any obsolete explicit-only authorization guidance — resolving the `plan-contract-partial` recurring-finding class for this story's documentation surface.
- `gantry local start|reset|reset-db|stop` are visible in top-level CLI help and dispatch through `apps/core/src/cli/local.ts` without forcing normal settings parsing before local bootstrap; `gantry local` with no subcommand prints usage and starts nothing; `local status`/`local doctor` no longer exist as duplicates of the top-level commands.
- Source-local startup validates Node 24 and source checkout, resolves runtime home with precedence `--runtime-home` > `GANTRY_HOME` > `<repo>/.gantry`, creates missing private `.env` defaults, and preserves existing values.
- Every destructive or mutating step (database reset, filesystem reset, migration, container start) is preceded by home safety, Node version, database-target authority (via a reversible bootstrap-then-check against the authoritative Postgres settings revision per decision 0025), and authentication-mode authority checks; a failed check leaves existing state and running children untouched — no partial reset, no stopped/started children.
- A genuinely fresh runtime home gets a Gantry-written ownership marker at the moment of first bootstrap, never retroactively; filesystem reset refuses on any home without one, with a manual remediation, not an automatic adoption path. Database reset refuses unless the target is the exact verified home-owned managed Postgres container's endpoint (the same check `local stop` already performs), never merely "a reachable loopback database named `gantry`", and refuses a non-default `GANTRY_DATABASE_URL` for reset outright.
- Source-local startup refuses, before touching the database or filesystem, when the authoritative settings (latest Postgres revision, or `settings.yaml` for a genuinely fresh home) declare a non-default `storage.postgres.url_env` or `.schema`, or when `GANTRY_SETTINGS_POSTGRES_SCHEMA`/a URL `schema=` param/`GANTRY_DB_SCHEMA` would redirect migrations elsewhere, naming the conflict and how to align it.
- A reset that crashes after the database schema commit but before filesystem cleanup finishes leaves a durable marker naming the interrupted variant; the next start/reset/reset-db refuses with a clear message instead of starting against mixed old/new state, lifted only by an explicit `--after-manual-recovery` flag after the operator inspects local state.
- Local startup validates a loopback control origin, creates or verifies authentication `canonicalOrigin`, runs migrations before starting source core and Vite, proxies browser auth/API traffic through Vite, and prints the stable UI URL only after health is ready (the proxied `/healthz`, not `/readyz`).
- Local DB handling reuses a reachable loopback DB, starts Compose only for the verified home-owned default Postgres container, refuses unreachable custom DBs, and refuses foreign `gantry-postgres` containers.
- `gantry local stop` stops source core and Vite through the local supervisor socket and stops only the verified home-owned managed Postgres container; custom Postgres is left alone; stop refuses to stop that container while an orphaned core process still holds an active database connection after this invocation's own children are shut down.
- Reset commands run every precondition before stopping any verified local children, refuse unsafe homes, non-loopback/non-`gantry` reset targets, and any home/database that fails ownership verification, recreate only `gantry` and `pgboss` under the reset-in-progress marker, preserve `.env`, `postgres/`, unknown files, and unrelated processes, then restart through the same healthy-start path.
- `reset-db` writes the just-validated authoritative settings revision out to `settings.yaml` (the matching recovery copy) before dropping `settings_revisions`, so a post-reset restart reflects the same desired configuration instead of stale/default YAML.
- Every successful start/reset first confirms `authentication.mode` is `local` and the public origin is loopback, then attempts (mandatory-attempt, fail-open) a fresh one-time authorization link via the same in-process issuance path `gantry ui authorize` uses after readiness — the raw URL only on an interactive TTY, otherwise the stable UI URL plus a `--runtime-home`-inclusive retry command and never the raw token; a failed issuance for any reason leaves the healthy dev stack running.
- `gantry local stop` (and the next `local start`'s preflight) detects and terminates a leftover orphaned Vite process via a recorded PID file, even after the supervisor itself previously crashed.
- Existing sessions remain valid after a restart or a freshly issued link without a reset; `reset`/`reset-db` end all sessions by design. Manual verification proves restart-session-survival without storing raw URLs or tokens in artifacts.
- `python3 scripts/check_architecture.py` passes because `scripts/architecture-exceptions.json` contains a single, time-bounded `direct_risky_execution` exception for `apps/core/src/cli/local.ts`, capped to the current direct spawn count only.
- Full Forge closeout runs required focused tests, deterministic verify, one autoreview pass across quality/performance/security, records evidence, and raises the PR.

**Write scope** (what `stage done` measures the diff against)

- package.json
- apps/core/src/cli/index.ts
- apps/core/src/cli/local.ts
- apps/core/src/cli/local-postgres.ts
- apps/web/vite.config.ts
- apps/core/test/unit/cli/index-local-routing.test.ts
- apps/core/test/unit/cli/local-postgres.test.ts
- scripts/architecture-exceptions.json
- README.md
- docs/architecture/overview.md
- docs/SPEC.md
- apps/core/src/adapters/storage/postgres/storage-readiness.ts
- plans/roadmap.json

**Required tests** (run by `stage done`)

- `bare gantry local prints usage and starts nothing` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `local status and local doctor no longer exist as duplicate commands` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `filesystem reset refuses a runtime home with no ownership marker` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `full reset rewrites the ownership marker only on an already-marked home` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database reset refuses a non-default GANTRY_DATABASE_URL outright` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database reset refuses a reachable custom database coincidentally named gantry` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `reset preconditions run before any already-running child is stopped` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `database-target authority refuses a conflicting storage.postgres.schema before any destructive step` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authentication-mode authority refuses before any child process starts` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `a stale reset-in-progress marker refuses and names the interrupted variant` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `a stale reset-in-progress marker is cleared only by --after-manual-recovery` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `reset-db writes the validated settings revision to settings.yaml before dropping settings_revisions` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `stop refuses to stop Postgres while an orphaned core connection remains` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `stop detects and terminates a leftover orphaned Vite process via the recorded PID file` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authorization link prints the raw URL only on an interactive TTY` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `authorization issuance failure leaves the healthy dev stack running` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `IPv6 bracketed control host is normalized before binding` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/index-local-routing.test.ts)
- `ownedPostgres verifies the container's published host and port binding` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)
- `ownedPostgres is called unconditionally before any reset` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)
- `pg_stat_activity check reports any active database client, not only core` -- `VITEST_JUNIT=1 npx vitest run -c vitest.unit.config.ts {path} -t {id} --outputFile={report}` (apps/core/test/unit/cli/local-postgres.test.ts)

**Verify commands**

- `npm run test:unit -- apps/core/test/unit/cli/index-local-routing.test.ts apps/core/test/unit/cli/local-postgres.test.ts`
- `npm run format:check`
- `npm run format:check:web`
- `npm run typecheck`
- `npm run build:core`
- `npm run build`
- `python3 scripts/check_architecture.py`
- `python3 factory/scripts/verify.py`
<!-- /forge:contract -->


## What to return

Findings only: contradictions, gaps, unstated assumptions, and anything a reader would have to guess. Say what would break and why. Do not record a gate — the coordinating session records it.

The round count below is a FLOOR, not a target. Keep grilling until a round comes back clean AND stays clean on the next one — hitting the floor is not the same as passing.
