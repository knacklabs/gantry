# Cold-read grill — gate: plan — plan draft local-dev-full-plan-draft.md

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

## The artifact under interrogation (plan draft local-dev-full-plan-draft.md)

---
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0118-identity-scoped-approval-and-grants
  - 0119-provider-neutral-group-approver-bootstrap
  - 0120-local-cli-structured-invocation
  - 0122-capability-template-amendment
  - 0123-recovery-proposal-birthright
  - 0124-bounded-durable-card-delivery
  - 0125-host-only-template-amendment
  - 0126-typed-terminal-denial-event
  - 0127-tagged-setup-action-model
  - 0128-permission-approval-result
  - 0129-capsafe-local-cli-terminal-wildcard
  - 0130-capsafe-capability-run-dispatch-only
  - 0132-adaptive-browser-authentication-access
  - 0133-gantry-tool-correlation-response-meta
  - 0134-autonomous-compound-runcommand-leaf-authorization
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0138-agents-are-service-kind-persons
  - 0142-third-console-role-approver
  - 0143-browser-write-only-secret-ingest
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
  - 0153-learned-decisions-project-into-job-grants
  - 0154-human-decision-memory-generic-scope
  - 0155-default-allow-gantry-tools-interactive-auto
  - 0156-ai-employee-console-resumable-deployment
  - 0157-jobs-use-the-chat-permission-ladder
  - 0158-provider-session-context-ceiling
  - 0159-adapter-session-release-port
  - 0160-physical-column-naming-is-snake-case
  - 0161-granted-capabilities-must-be-discoverable
---

## Problem

The Lite local-development change has already landed in this worktree, but the user has promoted the story back to Full Forge. The remaining planning problem is to make that existing implementation PR-ready without broadening the feature: `npm run dev` / `gantry local start` should run the source core and Vite together, keep the managed local database reusable, emit a fresh single-use browser authorization link after every healthy start, and keep production `npm start` / packaged runtime behavior unchanged.

The current implementation also trips `python3 scripts/check_architecture.py` because `apps/core/src/cli/local.ts` directly spawns long-lived child processes. That is intentional for a trusted operator local supervisor, but the architecture ratchet needs a narrow, count-exact exception so this does not become permission-bypass precedent for agent/tool execution.

A cold-read spec grill (recorded, `.factory/grills/spec.json`) found the Lite implementation has real destructive-safety and authority gaps that a Full Forge closeout must not paper over: `local reset` can destroy a database or directory it never verified it owns, the supervisor can reset one database while core actually runs against another, and startup can try to issue a browser-authorization link in an authentication mode that can never support it. A second cold-read grill of the requirements round (recorded, `.factory/grills/requirements.json`) re-read the spec against actual repository state and decision 0025/0003, and found the settings-authority check named the wrong source of truth, the ownership-marker design as first drafted would have violated decision 0003's no-backcompat-adoption rule (an earlier version of this plan actually proposed the forbidden retroactive-marking shim — removed below), there was no observable recovery for a crash between the database commit and filesystem cleanup, and the one-time authorization credential had no protection against non-interactive stdout capture. The owner resolved every finding in both rounds (`docs/specs/local-dev-launch.md`); this plan implements all of those resolutions. The owner also asked, mid-story, for the existing build commands to be documented and for a `build:core` command extracted from `build:runtime`, reusing existing scripts rather than adding new build machinery, and separately asked to commit in small, verified patches rather than one large commit.

## Scope / Non-goals

In scope:

- `package.json`, `apps/core/src/cli/index.ts`, `apps/core/src/cli/local.ts`, `apps/web/vite.config.ts`, `apps/core/test/unit/cli/index-local-routing.test.ts`, `scripts/architecture-exceptions.json`, `README.md`, and Forge proof/docs artifacts. No new source files.
- Preserve the already implemented Lite behavior unless a focused test proves it wrong, or the spec-grill resolutions below require a change.
- Add exactly one architecture exception for the one direct `spawn` call in `apps/core/src/cli/local.ts`, with a reason that limits it to the trusted operator-owned source supervisor.
- Reset and stop ownership: write a Gantry-created ownership marker ONLY at the moment a genuinely new runtime home is first bootstrapped (never retroactively onto an existing unmarked home — decision 0003 forbids that adoption path); require the marker before filesystem reset, refusing an unmarked home with a manual remediation instead. Require `local reset`/`local reset-db` to target only the verified home-owned managed Postgres container's exact endpoint (reusing the existing `ownedPostgres` check `local stop` already has, run unconditionally before reset), refusing a reachable custom database even if it is loopback and named `gantry`, and refusing a non-default `GANTRY_DATABASE_URL` for reset outright.
- Preflight-then-destroy ordering: run every precondition (home safety, Node version, database-target authority, authentication-mode authority) before any destructive or mutating step, including before stopping already-running local children for a reset; a failed precondition leaves existing state and running children untouched.
- Database-target authority: per decision 0025, the latest Postgres settings revision is authoritative when one exists; a reversible bootstrap-then-check starts only the verified home-owned container to read it, then stops it again on failure. Refuse before any destructive step if the authoritative settings declare a non-default `storage.postgres.url_env` (correct key name) or `.schema`, or if `GANTRY_SETTINGS_POSTGRES_SCHEMA` / a URL `schema=` param / `GANTRY_DB_SCHEMA` would redirect migrations to a different schema than core will use.
- Reset crash recovery: write a durable reset-in-progress marker before the destructive database step, clear it only after that reset variant's last destructive step completes; a subsequent command finding a stale marker refuses with a clear message and a rerun remediation rather than starting against mixed old/new state. This is a durable flag and a refusal, not a new lock.
- Authentication-mode authority: refuse before starting any child process if `authentication.mode` is not `local` or the public origin is not loopback, instead of starting a healthy stack and then failing authorization forever.
- Token-output safety: print the raw one-time authorization URL only when stdout is an interactive TTY; for non-TTY stdout, print only the stable UI URL and a `--runtime-home`-inclusive retry command, never the raw token.
- Orphan-stop refusal: `local stop` refuses to stop the managed Postgres container if, after this invocation's own managed children are shut down, the database still shows an active connection from an orphaned core process (reusing the existing `pg_stat_activity` check already used by reset) — not a public health probe, since core's port is private behind Vite and would falsely read as "nothing running" if only Vite died.
- CLI surface: remove the undocumented, duplicate `local status`/`local doctor` (top-level `gantry status`/`gantry doctor` already cover this); bare `gantry local` prints usage and does not start anything.
- One small IPv6 fix: `GANTRY_CONTROL_HOST`'s literal bracketed form is normalized before being handed to a bind-style API (URL construction still needs the brackets).
- Session-preservation criterion is narrowed to restart/relaunch without a reset; `reset` and `reset-db` both recreate the `gantry` schema and end all sessions by design.
- `settings.yaml`'s Surface Impact is `Changed`, matching what the code already does (creates it, deletes/recreates it on full reset); it is authoritative only for a genuinely fresh home with no settings revision yet, per decision 0025.
- Build commands: extract `build:core` (backend-only artifacts, no web) out of `build:runtime`, keeping `build:runtime`'s and `build`'s effective output identical; document the full build-command set and its separation from the dev/local commands in `README.md` and the spec.
- Deferred items are registered on the ledger, not merely stated in prose: D-0092 (Docker-only startup) and D-0093 (cross-process reset lock), both via `./forge defer add`.
- Commit in small, focused, individually-verified patches as the implementation proceeds, rather than one commit at stage close; keep Forge evidence commits separate from product-code commits where the split is clean.
- Keep `npm run dev:core` as the old core-only source command.
- Keep `npm start` as the built, core-only production command.
- Keep source-local dev on reachable loopback DB reuse; start Compose only for the verified home-owned default Postgres container.
- Issue a fresh short-lived, single-use UI authorization link after every successful `local start`, `local reset`, and `local reset-db` readiness check.
- Preserve existing browser sessions; a new link must not revoke already valid sessions.
- Record proof through Forge-approved scripts only.

Out of scope / deferred:

- Docker-only startup on a dedicated public port is deferred to a follow-up (D-0092); reopen when local source mode needs a containerized full stack instead of source core plus Vite.
- A new cross-process, DB-scoped mutual-exclusion lock for concurrent reset attempts is deferred (D-0093); preflight-then-destroy ordering, ownership verification, and the reset-in-progress marker are in scope, a new distributed-locking mechanism is not.
- Extending browser-authorization issuance to non-`local` authentication modes is out of scope; source-local dev requires `authentication.mode=local`.
- React page, component, styling, or route edits are out of scope.
- API/SDK schema changes are out of scope.
- Database schema changes and migration-hash repairs are out of scope.
- Reworking agent/tool command execution, sandbox policy, or `approved-command-runner` is out of scope.
- Adding a real (non-mocked) Postgres/Docker integration test lane is out of scope; focused mocked unit tests plus manual disposable-home verification is the agreed bar for this PR.
- Resetting real developer or production data during verification is forbidden; use disposable runtime homes and disposable databases only.
- Authorization tokens/URLs must not be copied into proof artifacts, PR bodies, or logs captured as evidence.

## Acceptance Criteria

- `npm run dev` builds contracts and routes to `gantry local start`; `npm run dev:stop`, `npm run reset`, and `npm run reset:db` route to their local CLI commands; `npm run dev:core` remains the core-only source command.
- `npm run build:core` builds backend artifacts only (contracts, SDK, core `tsc`, migrations copy, CLI executable bit), composed from the same steps `build:runtime` already uses; `npm run build:runtime` and `npm run build` produce the same `dist/` output as today.
- `gantry local start|reset|reset-db|stop` are visible in top-level CLI help and dispatch through `apps/core/src/cli/local.ts` without forcing normal settings parsing before local bootstrap; `gantry local` with no subcommand prints usage and starts nothing; `local status`/`local doctor` no longer exist as duplicates of the top-level commands.
- Source-local startup validates Node 24 and source checkout, resolves runtime home with precedence `--runtime-home` > `GANTRY_HOME` > `<repo>/.gantry`, creates missing private `.env` defaults, and preserves existing values.
- Every destructive or mutating step (database reset, filesystem reset, migration, container start) is preceded by home safety, Node version, database-target authority (via a reversible bootstrap-then-check against the authoritative Postgres settings revision per decision 0025), and authentication-mode authority checks; a failed check leaves existing state and running children untouched — no partial reset, no stopped/started children.
- A genuinely fresh runtime home gets a Gantry-written ownership marker at the moment of first bootstrap, never retroactively; filesystem reset refuses on any home without one, with a manual remediation, not an automatic adoption path. Database reset refuses unless the target is the exact verified home-owned managed Postgres container's endpoint (the same check `local stop` already performs), never merely "a reachable loopback database named `gantry`", and refuses a non-default `GANTRY_DATABASE_URL` for reset outright.
- Source-local startup refuses, before touching the database or filesystem, when the authoritative settings (latest Postgres revision, or `settings.yaml` for a genuinely fresh home) declare a non-default `storage.postgres.url_env` or `.schema`, or when `GANTRY_SETTINGS_POSTGRES_SCHEMA`/a URL `schema=` param/`GANTRY_DB_SCHEMA` would redirect migrations elsewhere, naming the conflict and how to align it.
- A reset that crashes after the database schema commit but before filesystem cleanup finishes leaves a durable marker; the next start/reset refuses with a clear message and a rerun remediation instead of starting against mixed old/new state.
- Local startup validates a loopback control origin, creates or verifies authentication `canonicalOrigin`, runs migrations before starting source core and Vite, proxies browser auth/API traffic through Vite, and prints the stable UI URL only after health is ready (the proxied `/healthz`, not `/readyz`).
- Local DB handling reuses a reachable loopback DB, starts Compose only for the verified home-owned default Postgres container, refuses unreachable custom DBs, and refuses foreign `gantry-postgres` containers.
- `gantry local stop` stops source core and Vite through the local supervisor socket and stops only the verified home-owned managed Postgres container; custom Postgres is left alone; stop refuses to stop that container while an orphaned core process still holds an active database connection after this invocation's own children are shut down.
- Reset commands run every precondition before stopping any verified local children, refuse unsafe homes, non-loopback/non-`gantry` reset targets, and any home/database that fails ownership verification, recreate only `gantry` and `pgboss` under the reset-in-progress marker, preserve `.env`, `postgres/`, unknown files, and unrelated processes, then restart through the same healthy-start path.
- Every successful start/reset first confirms `authentication.mode` is `local` and the public origin is loopback, then emits a fresh one-time authorization link via the existing `gantry ui authorize` flow after readiness — the raw URL only on an interactive TTY, otherwise the stable UI URL plus a `--runtime-home`-inclusive retry command and never the raw token; a failed issuance for any other reason leaves the healthy dev stack running.
- Existing sessions remain valid after a restart or a freshly issued link without a reset; `reset`/`reset-db` end all sessions by design. Manual verification proves restart-session-survival without storing raw URLs or tokens in artifacts.
- `python3 scripts/check_architecture.py` passes because `scripts/architecture-exceptions.json` contains a single, time-bounded `direct_risky_execution` exception for `apps/core/src/cli/local.ts`, capped to the current direct spawn count only.
- Full Forge closeout runs required focused tests, deterministic verify, one autoreview pass across quality/performance/security, records evidence, and raises the PR.

## Technical Approach

Keep the existing implementation shape and tighten only the Full Forge gaps. `local.ts` remains the local source-mode coordinator because it already owns runtime-home resolution, local DB handling, resets, child supervision, health readiness, and auth-link issuance. Splitting this into a new service layer would add ceremony without changing the trusted local-operator boundary.

`approved-command-runner` is not the right helper here. It is a bounded, buffered command runner for already approved commands: it pipes stdout/stderr, enforces a timeout, redacts retained output, and returns only after the child exits. The local source supervisor needs long-lived children with inherited stdio, process-group termination, health polling, sibling shutdown, and a stop socket. Forcing it through the buffered runner would either break dev-server interactivity or require building a second supervisor on top of it.

The direct-spawn architecture exception must therefore be narrow and honest: one file, one rule, current count only, reason tied to a human operator starting a trusted source checkout, and removal condition tied to a future source-supervisor application port if this boundary becomes shared. It must not approve direct execution from agents, jobs, provider adapters, tool calls, or arbitrary shell input.

Auth link generation should continue to reuse `gantry ui authorize` instead of duplicating token creation. That keeps expiry, single-use storage, hashing, and browser-auth redemption in the existing auth path. The supervisor should print only labels and retry instructions around that command; it must not persist plaintext authorization URLs.

Vite should stay the public loopback surface for source-local dev and proxy `/ui/api`, `/auth`, `/v1`, `/healthz`, `/readyz`, and `/metrics` to the private source core. Production built UI serving remains untouched.

The two spec grills' resolved findings become a set of small, targeted additions to `local.ts`, none of which change its shape as a single CLI coordinator:

- **Ownership marker, bootstrap-only.** When `localEnvironment` bootstraps a home that did not exist before this invocation created it (the same branch that currently seeds `.env` defaults for a fresh home), also write a small Gantry-owned marker file. It is never written to an already-existing, unmarked home — the requirements grill found that "retroactive marking" is exactly the compatibility/adoption path decision 0003 forbids. `validateLocalHome`'s existing unsafe-path/symlink checks are necessary but not sufficient — they rule out obviously wrong homes, not confirm Gantry created this one. Filesystem reset refuses on a home without the marker, with a manual remediation (move/delete the old home, or use a new `--runtime-home` so a fresh, marked home is bootstrapped).
- **Database ownership bound to the reset endpoint.** `resetLocalDatabase` currently accepts any loopback DB literally named `gantry`/schema `gantry`, and `ensureLocalDatabase` only calls the existing `ownedPostgres` check on its fresh-start path, returning early (skipping the check) whenever the target is already reachable. Call `ownedPostgres` unconditionally before any reset, for the same container the supervisor is about to migrate/reset; refuse reset outright for a non-default `GANTRY_DATABASE_URL`, since a custom target's ownership can never be verified against a specific Docker container.
- **Reversible bootstrap-then-check for settings authority.** Decision 0025 makes the latest Postgres settings revision authoritative, but reading it needs Postgres up, and nothing destructive may run before authority is confirmed. Start (or confirm running) only the verified home-owned container as a reversible preflight step, read the latest settings revision (falling back to `settings.yaml` only when no revision exists yet — a genuinely fresh home), validate `storage.postgres.url_env` (the actual key; not `urlEnv`) and `.schema` plus `GANTRY_SETTINGS_POSTGRES_SCHEMA`/URL `schema=`/`GANTRY_DB_SCHEMA` against the local-mode defaults, then either continue or stop that container again before returning a precondition failure.
- **Full preflight reordering, including reset's own child-stop.** `runLocalCommand`'s `reset`/`reset-db` branch currently calls `stopLocalDevelopment(home)` before `superviseLocal` runs any of the checks above — move every precondition (home safety, Node version, database-target authority, authentication-mode authority) ahead of that stop call, so a failed precondition never leaves already-stopped children as a side effect.
- **Authentication-mode authority.** Before starting any child process, refuse when `authentication.mode` is not `local` or the origin is not loopback — `gantry ui authorize` already refuses non-local mode correctly (`apps/core/src/cli/auth.ts`), the gap is only that `local.ts` does not check first, so it starts a healthy stack and then fails authorization forever.
- **Reset-in-progress marker for crash recovery.** Write a durable marker file immediately before `resetLocalDatabase` runs; remove it only after that reset variant's last destructive step (filesystem cleanup for `reset`, schema recreation for `reset-db`) completes. A subsequent command that finds a stale marker refuses with a clear message and a rerun remediation. This is a durable flag plus a refusal, not a lock — concurrent-reset mutual exclusion stays deferred (D-0093).
- **TTY-gated token output.** Print the raw authorization URL only when `process.stdout.isTTY` is true; otherwise print the stable UI URL plus a `--runtime-home`-inclusive retry command and never the raw token, so non-interactive capture (shell redirection, IDE task logs, CI) can never persist the credential.
- **Orphan-stop refusal via the database, not a public probe.** Core binds a private ephemeral port behind Vite, so a public-origin health probe cannot see an orphaned core process if Vite died. Reuse the existing `pg_stat_activity` active-connection check (already used by `resetLocalDatabase`) in `runLocalCommand`'s `stop` branch, run after this invocation's own managed children are shut down: if any other connection remains, refuse to stop Postgres and report the orphaned state.
- **CLI-surface reduction.** Remove `local status`/`local doctor` (duplicates of the existing top-level `gantry status`/`gantry doctor`); make bare `gantry local` print usage instead of dispatching to `start`.
- **IPv6 fix.** Normalize the `[::1]` literal bracket form before it reaches a bind-style API (construction of the `http://` origin URL already needs the brackets; a raw bind/listen call does not).

Build commands: extract the non-web portion of `build:runtime`'s step list into a new `build:core` script (contracts, SDK, `tsc`, migrations copy, chmod), then redefine `build:runtime` as `build:core && build:web && copy:web`. The resulting `dist/` output is unchanged; the seam is just named and independently runnable, mirroring `dev:core`'s relationship to `dev`.

Workflow: this is one Full Forge story with one implementation task. The additions above are all inside the same coordinator file and its tests — none introduce a new module, a new dependency, or a new architectural seam, so splitting into more tasks would add ceremony without a real boundary to split on. The story is visible CLI behavior, but the implementation task records `user_facing: false` because it does not build UI screens, components, styling, or motion. After the draft is approved, record the plan, record decomposition, run the task grill, implement only the scoped files, record tests, run deterministic verify, run the single autoreview helper for quality/performance/security, record reviews, record outcome, and run `pr_ready.py` before opening the PR.

## Decisions

No new decision files were created in this planning draft; the spec grill's resolutions were recorded as spec text (`docs/specs/local-dev-launch.md`, confirmed) rather than new decisions, since they implement existing decisions 0025 and 0132 rather than establishing new policy.

The operator-supervisor exception is already approved in `docs/specs/local-dev-launch.md` as: “A narrow one-call exception covers the operator-owned source supervisor; agent/tool execution remains behind the existing sandbox boundary.” This plan and its task own adding the exact, count-exact, time-bounded exception entry to `scripts/architecture-exceptions.json` — the exception does not exist yet on disk (confirmed by the spec grill); do not treat the spec's description of it as already satisfied.

Existing decisions that govern the plan include `0001-agent-runtime-platform` and `0018-provider-neutral-agent-execution-adapter` for the sandbox boundary, `0023-deployment-modes` and `0025-settings-authority` for local vs production runtime shape and settings-revision authority, `0120-local-cli-structured-invocation` for local CLI capability discipline, `0132-adaptive-browser-authentication-access` for browser auth and the loopback/local-mode requirement, and `0143-browser-write-only-secret-ingest` for secret/token handling.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| runtime behavior | Changed | Source-local start/reset supervises source core plus Vite and emits a fresh auth link after readiness; production `npm start` remains unchanged. |
| API | Unchanged by design | Browser auth, health, ready, metrics, and `/v1` routes are reused through the Vite proxy; no route contract changes. |
| data/schema | Unchanged by design | No migrations or schema edits; auth-code persistence uses the existing `gantry ui authorize` writer. |
| CLI/ops | Changed | `npm` scripts and `gantry local start/reset/reset-db/stop` route through the local supervisor; `local status`/`local doctor` are removed as duplicates and bare `gantry local` now prints usage. |
| UI | Read-only | Vite config proxies the existing web app; no React page/component edits. |
| docs | Changed | This plan plus Forge proof/docs updates; existing spec already captures the approved Full scope and deferral. |
| tests | Changed | Focused CLI local-routing tests cover env/home precedence, DB/reset boundaries, ownership/authority refusals, preflight ordering, orphan-stop refusal, supervisor ordering, auth-link issuance failure, and stop behavior. |
| settings.yaml | Changed | Local startup creates it when missing and full reset deletes/recreates it; authoritative only for a genuinely fresh home with no settings revision yet (decision 0025 governs otherwise); validates `authentication.canonicalOrigin` and `storage.postgres.url_env`/`schema` against the local defaults; existing conflicting settings fail with remediation. Reimport as the authoritative revision on next core startup is existing bootstrap behavior, not new code. |
| Postgres/runtime projection | Changed | Local reset recreates `gantry`/`pgboss` only against the verified home-owned managed container's exact endpoint, guarded by a reset-in-progress marker; auth link issuance inserts hashed single-use authorization state through existing storage. |
| control API | Unchanged by design | Existing browser-auth redemption path is reused. |
| SDK/contracts | Unchanged by design | No generated contracts or SDK APIs change. |
| Gantry MCP tools/admin skill | N-A | No MCP/admin tool surface changes. |
| channel/provider adapters | Unchanged by design | Local browser auth and dev startup do not alter provider/channel adapters. |
| audit/events | Unchanged by design | Existing auth flow owns any related events; local supervisor adds no new audit contract. |

## Task Decomposition

1. `LOCAL-DEV-FULL-T1` — Full local source-dev supervisor closeout

   Story visibility: true for CLI behavior. Task `user_facing: false`.

   Objective: finish the promoted Full Forge local-dev story as a single backend/CLI tooling task, preserving Lite behavior while adding the narrow architecture exception and PR-ready proof.

   Write scope: `package.json`, `apps/core/src/cli/index.ts`, `apps/core/src/cli/local.ts`, `apps/web/vite.config.ts`, `apps/core/test/unit/cli/index-local-routing.test.ts`, `scripts/architecture-exceptions.json`, `README.md`, and Forge proof/docs artifacts only. No new source files.

   Acceptance criteria: all criteria in this plan’s Acceptance Criteria section.

   Required tests: focused unit coverage in `apps/core/test/unit/cli/index-local-routing.test.ts` for local command routing (including bare `gantry local` printing usage and `local status`/`local doctor` no longer existing), runtime-home precedence, `.env` default preservation, loopback origin/DB validation, managed/default DB vs custom DB behavior, reset file boundaries, migration-before-core ordering, Vite/core launch, auth-link launch after readiness, auth-link failure nonfatal behavior, stop socket/process-group cleanup, `gantry local stop` managed-container limits, bootstrap-only ownership-marker-gated filesystem reset (never retroactive), database-ownership-gated database reset bound to the exact managed endpoint (including refusal of a coincidentally-named custom database and outright refusal of a non-default `GANTRY_DATABASE_URL`), preflight-then-destroy ordering including reset's own child-stop moving after preflight, database-target-authority refusal on a conflicting settings revision/`settings.yaml`/schema-override env var, authentication-mode/loopback-authority refusal before any child process starts, reset-in-progress marker refusal after a simulated crash between DB commit and filesystem cleanup, orphan-stop refusal via the active-connection check when core is orphaned with no active socket, TTY-gated vs non-TTY authorization output, the `--runtime-home`-inclusive retry message, and IPv6 bracket-form host normalization.

   Reviewer focus: enforce the constitution and ponytail shape. This should remain a small CLI coordinator, not a new framework. Reviewers should specifically check that the direct-spawn exception is count-exact and operator-local only; no agent/tool sandbox bypass was introduced; no production start path changed; no migration hashes or schema files were repaired; no real-data reset is required for verification; no raw authorization tokens/URLs appear in artifacts; every destructive step is genuinely preceded by its precondition checks (not merely reordered in appearance); the ownership marker is never written to a pre-existing unmarked home (decision 0003); and the ownership/authority checks reuse existing helpers (`ownedPostgres`, `ensureRuntimeSettings`, the `pg_stat_activity` query) rather than introducing new abstractions.

## Risks

- Architecture exception drift: a broad exception would normalize direct risky execution outside the sandbox boundary. Mitigation: one file, one rule, max current count, reason tied to trusted local operator supervision, and architecture check in required verification.
- Token leakage in evidence: successful auth output may include a usable URL. Mitigation: do not paste raw authorization links into `.factory`, docs, PR bodies, or chat; record only that a link was printed/redacted.
- Reset blast radius: reset commands can destroy local state if path/DB checks regress. Mitigation: preserve unsafe-home, symlink, non-loopback DB, wrong DB/schema, active-client, `.env`, `postgres/`, and unknown-file tests; manual verification uses disposable homes only.
- False confidence from mocked supervisor tests: unit tests prove orchestration order but not real browser/session behavior. Mitigation: add manual disposable-home verification for link redemption and existing-session preservation.
- Long-running test lanes may be noisy in this checkout. Mitigation: run focused tests first, then deterministic verify; report exact pass/fail/block status and do not call silent or nonterminating Vitest runs green.
- Existing recurring finding `plan-contract-partial` is not in this local-dev area. Tripwire: if plan grill or autoreview flags partial acceptance criteria again, amend this plan before implementation rather than patching around it.
- Ownership-marker false refusal: an existing home from before this change has no marker and would be refused on first `local reset` after upgrade. Mitigation: this is intentional, not a bug — decision 0003 forbids retroactively adopting an unmarked home as reset-authorized. `local start`/`reset-db` are unaffected; the documented remediation for an old home is to move it aside or point `--runtime-home` at a new path so a fresh, marked home is bootstrapped. Call this out explicitly in the PR body and README as a deliberate, one-time upgrade note.
- Database-authority false refusal: a developer who intentionally customized `storage.postgres.url_env`/`schema` for source-local dev would now be refused. Mitigation: the refusal message must name the exact conflicting setting and how to align it, and this is accepted as intended per the owner's decision to enforce authority defaults.
- Reset-in-progress marker false refusal: a genuinely interrupted reset (not a crash) — e.g. the operator's own Ctrl-C during reset — also leaves the marker and triggers the same refusal on next run. Mitigation: this is the correct behavior (the reset truly did not finish); the remediation message says to rerun the same reset command, which is always safe since reset is idempotent per the ownership/authority checks.

## Verify Plan

Automated verification:

- `npm run test:unit -- apps/core/test/unit/cli/index-local-routing.test.ts`
- `npm run format:check`
- `npm run typecheck`
- `npm run build:core` (confirms the extracted script still produces backend artifacts)
- `npm run build` (confirms `dist/` output is unchanged end-to-end)
- `python3 scripts/check_architecture.py`
- `python3 .agents/scripts/verify.py --print-only` to confirm the deterministic gate shape before the full run
- `python3 .agents/scripts/verify.py`

Manual Verification:

- Use a disposable `--runtime-home` under a temporary directory and a disposable loopback Postgres target only; do not touch real developer or production runtime data.
- Start with `npm run dev -- --runtime-home <tmp-home>` or `npm run cli:dev -- local start --runtime-home <tmp-home>` as supported by the script routing, verify health and UI URL, and confirm the authorization link is printed only after readiness. Redact the URL in notes.
- Redeem the first link in a browser, confirm the UI session works, restart local dev, and confirm a new link is printed while the existing session remains valid.
- Redeem the old link a second time or after issuing a new one and verify single-use behavior through the existing auth path; record only pass/fail, never the token.
- Run `gantry local stop --runtime-home <tmp-home>` and confirm source core/Vite stop and only the verified home-owned managed Postgres container is stopped. If using a custom DB, confirm it is reported as externally managed and left running.
- Run `gantry local reset-db --runtime-home <tmp-home>` and `gantry local reset --runtime-home <tmp-home>` against disposable state, confirming `.env`, `postgres/`, and unknown files are preserved while known runtime state is removed only for full reset, and confirming the ownership marker survives `reset-db` and is rewritten fresh by `reset`.
- Point a disposable home's `--runtime-home`/`GANTRY_DATABASE_URL` at a reachable custom loopback Postgres named `gantry`/`gantry` that is NOT the managed container, and confirm `local reset` refuses it instead of dropping its schema.
- Redirect a disposable authorization retry to a non-TTY sink (`gantry ui authorize > /tmp/out.txt`, or run inside the failure path with stdout piped) and confirm the raw URL never appears in that file, only the stable UI URL and retry command.
- Kill the process mid-`local reset` after its database step (a deliberate `kill -TERM` between schema recreation and filesystem cleanup on disposable state) and confirm the next command refuses with the reset-in-progress remediation instead of starting.

This manual pass against a real disposable Docker Postgres container is the project's DB-backed-change verification requirement (`docs/architecture/current-verification-commands.md`) satisfied without a new automated integration-test lane, since the behavior under test is CLI/process lifecycle, not application-layer database queries.

Forge closeout verification (evidence and PR mechanics are owned by the plan/harness, not the capability spec):

- Record automated test evidence via `record_test_from_json.py` with `generated_by: implementer`.
- Run the single autoreview helper once for quality, performance, and security; rerun only after accepted fixes, then record all three review artifacts.
- Run `python3 factory/scripts/pr_ready.py` after tests, verify, reviews, and outcome are recorded.
- Raise the PR after the gate passes, with PR text that states the local-dev goal, the narrow operator exception, verification limits, and token-redaction discipline.


## What to return

Findings only: contradictions, gaps, unstated assumptions, and anything a reader would have to guess. Say what would break and why. Do not record a gate — the coordinating session records it.

The round count below is a FLOOR, not a target. Keep grilling until a round comes back clean AND stays clean on the next one — hitting the floor is not the same as passing.
