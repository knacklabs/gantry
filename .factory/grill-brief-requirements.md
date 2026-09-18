# Cold-read grill — gate: requirements — requirements for LOCAL-DEV-1 (docs/specs/local-dev-launch.md)

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
- Q: The current staged diff is already 1,646 additions across eight files before the remaining destructive-safety work, and the sole task covers roughly twenty distinct proof seams — too large for one bounded task/PR.
  A: Keep one task with an explicit size budget

## The artifact under interrogation (requirements for LOCAL-DEV-1 (docs/specs/local-dev-launch.md))

---
slug: local-dev-launch
title: Local development launch and reset
status: confirmed
saved: 2026-09-17T13:16:48+00:00
---

# Local development launch and reset

## Why

The Lite local-development change has already landed in this worktree; the
user approved promoting it to Full Forge on 2026-09-17, with the scope
limited to `package.json`, the CLI index, CLI local, Vite configuration,
CLI local-routing tests, `scripts/architecture-exceptions.json`, plus
documentation and Forge proof. A narrow one-call architecture exception
covers the operator-owned source supervisor; agent/tool execution remains
behind the existing sandbox boundary. Production start and service behavior
stay unchanged.

Approved addition: `npm run dev:stop` / `gantry local stop` stops source
core, Vite, and the verified home-owned managed Postgres container without
deleting data or stopping unrelated Docker containers. Ctrl-C leaves
Postgres warm.

A cold-read spec grill found the original draft under-specified
destructive-operation safety and authority boundaries; the owner resolved
every finding, and this revision states those resolutions as requirements.
A second cold-read grill of the requirements round (re-reading this spec
against current repository reality — the actual `local.ts`, decision 0025,
and decision 0003) found further gaps: the spec checked the wrong settings
authority, proposed an ownership-marker design that would have violated
decision 0003's no-backcompat-adoption rule, missed a crash window between
the database commit and filesystem cleanup, and left the one-time
authorization credential unprotected against non-interactive stdout capture.
The owner resolved all of it; this revision states those resolutions too.

## Behaviour

### Commands

- `npm run dev` / `gantry local start`: start source core and Vite with HMR,
  ensuring Postgres is available and all current migrations have completed.
- `npm run reset` / `gantry local reset`: reset both Gantry database schemas,
  remove known Gantry runtime state, migrate, and restart into fresh onboarding.
- `npm run reset:db` / `gantry local reset-db`: reset both schemas, migrate,
  and restart while preserving runtime filesystem state.
- Keep the old core-only source command as `npm run dev:core`.
- `npm run dev:stop` / `gantry local stop`: stop source core, Vite, and the
  verified home-owned managed Postgres container only.
- `gantry local` with no subcommand prints usage and exits; it must not
  start Docker/core/Vite. `gantry local status`/`gantry local doctor` are
  removed — the existing top-level `gantry status`/`gantry doctor` already
  cover this, and a duplicate under `local` is an undocumented, redundant
  CLI surface.

Local dev commands run source directly (`tsx`, no core/web *production*
build and no root `dist/ui`) and stay entirely separate from artifact build
commands (below) and from the production commands `npm run build` / `npm
start`, which this change does not alter. (Every local command still runs
`build:contracts` to produce the typed contracts workspace output the CLI
itself depends on — that workspace build is not what "no build step" means
here.)

### Build commands

Building deployable artifacts is a distinct concern from running source
locally, and stays that way: `npm run dev`/`local start` never builds the
core/web production `dist/`, and building `dist/` never starts a dev server.
Document the existing build commands so the separation and the reuse are
explicit rather than implicit:

- `npm run build:contracts` / `npm run build:sdk` / `npm run build:web`:
  build one workspace's own artifacts. Unchanged.
- `npm run build:core`: build only the backend runtime artifacts (contracts,
  SDK, the core `tsc` output, migrations copy, CLI executable bit) with no
  web build or copy step — the artifact-build counterpart to `npm run
  dev:core`. New: extracted out of `build:runtime` so backend-only artifacts
  can be built independently of the web bundle, reusing the exact same
  underlying steps.
- `npm run build:runtime`: `build:core` plus `build:web` plus copying the
  web build into `dist/ui`. Behaviorally identical to today — restated as a
  composition of `build:core` and `build:web` instead of its own inlined
  step list.
- `npm run build`: `build:runtime` plus the SDK example build. Unchanged.
- `npm start`: `db:migrate` then run the built `dist/index.js`. Unchanged —
  production startup is untouched by this change.

### Environment and lifecycle

Source development defaults to gitignored `<repo>/.gantry`, with explicit
`--runtime-home` and exported `GANTRY_HOME` taking precedence. Create missing
local defaults in its `.env` with private permissions, preserving existing
values. Generate an encryption key. Use process environment before file values
for that generated bootstrap `.env` only; existing `.env` values are never
silently overwritten. Derive public host and port from `GANTRY_CONTROL_HOST`
and `GANTRY_CONTROL_PORT`, defaulting to loopback port 3939. Fresh
authentication configuration must match this origin; existing conflicts fail
with remediation.

Reuse the configured reachable loopback database. Start Compose only for the
managed default database, binding its storage to `<GANTRY_HOME>/postgres`.
Never silently replace an unavailable custom database or adopt a foreign
container by its name. Validate Node 24 and source-checkout prerequisites.

Before any destructive or mutating step (database reset, filesystem reset,
migration, container start), complete every precondition check: home safety,
Node version, database-target authority (below), and authentication-mode
authority (below). A precondition failure must leave existing state
untouched and exit before anything is deleted, migrated, or started.

Decision 0025 makes the Postgres `settings_revisions` table authoritative
over `settings.yaml`, but reading it requires Postgres to be reachable, and
authority must be confirmed before anything destructive runs. Resolve this
with a reversible bootstrap-then-check: start (or confirm running) only the
verified home-owned managed container as a preflight bootstrap step, read
and validate the latest settings revision against local-mode defaults, then
either continue into migrations/core/Vite or stop that container again
before returning a precondition failure. No migration, filesystem deletion,
or application child process runs until this check passes.

Run migrations before core, start core on a private loopback port, and expose
Vite on the public origin. Proxy browser authentication and API traffic to core.
Print the stable resolved UI URL when healthy. Ctrl-C stops children and leaves
Postgres warm. A child failure stops its sibling and exits nonzero. Development
must not fall back to built UI assets.

### Database-target authority

The database the local supervisor migrates and resets must be the same
database core will actually use at runtime, and that determination follows
decision 0025: the latest Postgres settings revision is authoritative when
one exists (read during the reversible bootstrap-then-check above), and the
runtime-home `settings.yaml` is authoritative only for a genuinely fresh
home with no revision yet. If the authoritative settings declare a
non-default `storage.postgres.url_env` (the actual settings key; not
`urlEnv`) or `storage.postgres.schema`, or if `GANTRY_SETTINGS_POSTGRES_SCHEMA`,
a `schema=` query parameter, or `GANTRY_DB_SCHEMA` would redirect migrations
to a different schema than core will use, source-local startup must refuse
before touching the database or filesystem, naming the conflicting setting
and how to align it, rather than silently operating on
`GANTRY_DATABASE_URL`/`gantry` while core would use something else.

### Reset ownership

Reset must not act on a database or directory tree it cannot show it owns.

- **Filesystem reset ownership.** Gantry writes a marker at the moment it
  bootstraps a genuinely new runtime home (a home directory that did not
  exist before this command created it) — never at any later point, and
  never onto a home that already existed. `local reset` refuses to touch
  `LOCAL_RESET_PATHS` under any home lacking that marker; there is no
  automatic or retroactive way to mark an existing, unmarked home, because
  treating an unrecognized directory as reset-authorized after the fact is
  exactly the compatibility/adoption path decision 0003 forbids. An unmarked
  home is refused with a manual remediation (move or delete the old home, or
  point `--runtime-home` at a new path, so a fresh, marked home is
  bootstrapped by `local start`). The marker survives `reset-db` and is
  rewritten fresh by a full `reset`.
- **Database reset ownership.** `local reset` and `local reset-db` may only
  run against the exact verified home-owned managed Postgres container: the
  same ownership check `local stop` already performs, run unconditionally
  before reset regardless of whether the target was already reachable, and
  bound to the specific container's published connection endpoint — not
  merely "a reachable loopback database named `gantry`". A reachable custom
  database that matches the name coincidentally is refused, not reset, and a
  non-default `GANTRY_DATABASE_URL` is refused for reset outright since its
  ownership cannot be verified.
- **Preflight-then-destroy ordering.** Every check above, and every stop of
  already-running local children, completes before the schema is dropped or
  any file is removed — reset must not stop the running supervisor and then
  discover a precondition failure with children already stopped.

### Reset crash recovery

A crash between the database schema commit and filesystem cleanup finishing
must be observable and refused, not silently treated as a clean reset target
on the next run. Write a durable reset-in-progress marker immediately before
the destructive database step, and remove it only after filesystem cleanup
(for a full reset) or after the schema recreation completes (for
`reset-db`) — whichever is that variant's last destructive step. A
subsequent `start`/`reset`/`reset-db` that finds a stale marker refuses with
a clear "a previous reset did not finish cleanly" message and a remediation
(rerun the same reset command to finish it) rather than starting core
against mixed old/new state. This is a durable flag and a refusal, not a
cross-process lock — the deferred mutual-exclusion lock (tracked separately)
is about concurrent reset attempts, not crash recovery.

### Orphan and stale-state recovery

`local stop` must not stop the managed Postgres container while a Gantry
core process it does not control is still using it. Core binds its own
loopback port privately behind Vite, so a public-origin health probe cannot
see an orphaned core process if Vite or the supervisor died — the check must
use the database itself: reuse the existing active-connection check (already
used by `resetLocalDatabase` via `pg_stat_activity`) after the managed
children this `stop` invocation controls have been shut down, and refuse to
stop Postgres while any other connection remains, reporting the orphaned
state with a remediation to locate and stop those processes directly.

### Approved automatic local authorization addition

On every successful source-local start, including ordinary restarts and both
reset variants, print a fresh short-lived (ten-minute), single-use
authorization link after health readiness — health meaning the public Vite
origin's proxied `/healthz` responds healthy, not the deeper `/readyz`
onboarding-readiness check, since fresh onboarding can legitimately leave
`/readyz` red. Reuse `gantry ui authorize` against the resolved runtime home
and public origin. Before starting any child process, require
`authentication.mode` to be `local` — the only mode `gantry ui authorize`
can ever serve — and a loopback public origin (decision 0132); refuse with
remediation before startup if not, rather than starting a healthy stack and
then failing authorization on every retry.

The raw authorization URL is a ten-minute administrator credential. Print it
in full only when stdout is an interactive terminal (a TTY); when stdout is
not a TTY (redirected to a file, captured by an IDE task runner, or CI),
keep the healthy development stack running and print only the stable UI URL
plus the resolved manual retry command (`gantry ui authorize
--runtime-home <home>`) — never the raw token — so non-interactive capture
can never persist the credential. Keep the stable UI URL available for
browsers with valid sessions regardless; issuing a new link must not revoke
those sessions. Do not persist plaintext authorization URLs in runtime
files. If link issuance fails for a reason other than an unsupported mode,
keep the healthy development stack running and print an actionable retry
command that includes the resolved `--runtime-home` flag, so retrying
targets the same home instead of a different default.

Existing browser sessions remain valid after ordinary restarts and after a
new link is issued without a reset. `reset` and `reset-db` both drop and
recreate the `gantry` schema, which holds session state, so no session can
survive either reset variant — the requirement is scoped to restart/relaunch
without a reset, not to reset itself.

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Issues an optional link after each healthy launch; preflights mode/origin/database authority first via a reversible bootstrap-then-check. |
| settings.yaml | Changed | Source-local startup creates it when missing, and full reset deletes and recreates it; the file is authoritative only for a genuinely fresh home with no settings revision yet — otherwise the latest Postgres settings revision (decision 0025) governs, and startup's existing bootstrap imports the file as that revision when none exists. |
| Postgres/runtime projection | Changed | Local reset recreates `gantry`/`pgboss` only against the verified home-owned managed container, guarded by a reset-in-progress marker; auth link issuance inserts hashed single-use authorization state through existing storage. |
| Control API | Unchanged by design | Existing authorization and redemption paths are reused. |
| SDK/contracts | Unchanged by design | No client-contract change. |
| CLI | Changed | Local supervisor invokes existing UI authorization command; `local status`/`local doctor` are removed as duplicates of top-level commands; build commands gain a documented `build:core` composition. |
| MCP/admin tools | Unchanged by design | No new administration operations. |
| Channel/provider adapters | Unchanged by design | Browser login does not alter adapters. |
| Docs/prompts | Changed | Describe automatic links, database/auth-mode authority, reset crash recovery, and build commands. |
| Audit/events | Unchanged by design | Existing authorization flow owns its events. |
| Tests/verification | Changed | Check readiness ordering, resolved environment, ownership/authority refusals, preflight ordering, orphan-stop refusal, reset-crash-marker refusal, TTY-gated token output, and issuance failure. |

Search README for obsolete explicit-only authorization guidance.

### Reset boundaries

Both commands run every precondition check (home safety, Node version,
database-target authority, authentication-mode authority) and stop verified
local children before any destructive step. They print the resolved home
and redacted database target. Refuse unsafe home paths, non-loopback
databases, databases not named `gantry`, and any database/home that fails
the ownership checks above. Recreate only `gantry` and `pgboss` under a
reset-in-progress marker, then run the complete current migration chain.
Full reset additionally removes known settings, onboarding, agents, data,
store, logs, artifacts, and runtime projection paths. Preserve `.env`,
`postgres/`, unknown files, unrelated processes, and user runtime data
during verification.

### Deferred

Docker-only startup on a dedicated port is explicitly deferred to a
follow-up (D-0092); this change retains reachable configured loopback
database reuse. A cross-process, DB-scoped mutual-exclusion lock for
concurrent reset attempts is explicitly deferred (D-0093) — preflight-then-
destroy ordering, ownership verification, and the reset-in-progress marker
are in scope; a new distributed-locking mechanism is not. No additional
dependencies or SDK/API schema changes are authorized.

## Acceptance criteria

- `npm run dev` / `gantry local start` runs migrations before starting source
  core and Vite together, and production startup (`npm start`) is unchanged.
- `npm run dev:core` remains available as the old core-only source command.
- `npm run build:core` builds backend artifacts only (no web build/copy),
  composed from the same steps `build:runtime` already uses; `npm run
  build:runtime` and `npm run build` produce the same `dist/` output as
  today.
- `gantry local` with no subcommand prints usage and does not start
  anything; `gantry local status`/`gantry local doctor` no longer exist as
  duplicates of the top-level commands.
- Every destructive or mutating step is preceded by home safety, Node
  version, database-target authority (checked against the authoritative
  Postgres settings revision when one exists, via a reversible
  bootstrap-then-check), and authentication-mode authority checks; a failed
  check leaves existing state untouched, with local children stopped only
  after every check passes.
- A genuinely fresh runtime home gets a Gantry-written ownership marker at
  the moment of its first bootstrap; filesystem reset refuses on any home
  without one, with no retroactive marking path. Database reset refuses
  unless the target is the exact verified home-owned managed Postgres
  container's endpoint, never merely "a reachable loopback database named
  `gantry`", and refuses outright for a non-default `GANTRY_DATABASE_URL`.
- Source-local startup refuses, before touching the database or filesystem,
  when the authoritative settings (the latest Postgres revision, or
  `settings.yaml` for a genuinely fresh home) declare a non-default
  `storage.postgres.url_env`/`schema`, or when `GANTRY_SETTINGS_POSTGRES_SCHEMA`
  / a URL `schema=` parameter / `GANTRY_DB_SCHEMA` would redirect migrations
  to a different schema than core will use — naming the conflict and how to
  align it.
- A reset that crashes after the database schema commit but before
  filesystem cleanup finishes leaves a durable marker; the next start/reset
  refuses with a clear message and a rerun remediation instead of starting
  against mixed old/new state.
- `npm run dev:stop` / `gantry local stop` stops source core, Vite, and the
  verified home-owned managed Postgres container only, without deleting data
  or stopping unrelated Docker containers, and refuses to stop that
  container while an orphaned core process still holds an active database
  connection after this invocation's own children have been shut down;
  Ctrl-C leaves Postgres warm.
- Reset commands stop verified local children only after every precondition
  passes, refuse unsafe home paths, non-loopback databases, databases not
  named `gantry`, and any home/database that fails ownership verification,
  recreate only `gantry` and `pgboss`, preserve `.env`, `postgres/`, unknown
  files, and unrelated processes, then restart through the same
  healthy-start path.
- Every successful start or reset first confirms `authentication.mode` is
  `local` and the public origin is loopback, then prints a fresh
  short-lived, single-use browser authorization link after health readiness
  (proxied `/healthz`, not `/readyz`) via `gantry ui authorize` — the raw
  link only when stdout is an interactive TTY, otherwise the stable UI URL
  plus a retry command that includes the resolved `--runtime-home`, never
  the raw token. A failed issuance for any other reason keeps the healthy
  dev stack running.
- Existing sessions remain valid after a restart or a freshly issued link
  without a reset; `reset` and `reset-db` both end all existing sessions by
  design, since they recreate the `gantry` schema. Manual verification
  proves session survival on restart without storing raw URLs or tokens in
  artifacts.
- Source development resolves the runtime home with precedence
  `--runtime-home` > `GANTRY_HOME` > `<repo>/.gantry`, creates missing
  private `.env` defaults while preserving existing values, and validates
  Node 24 and source-checkout prerequisites.
- Verification covers home/env precedence, bootstrap preservation, database
  reuse/startup, migration ordering, origin/proxy wiring, signal/child
  cleanup, reset deletion/ownership boundaries, unsafe-target refusal,
  database/auth-mode authority refusal, reset-crash-marker refusal,
  orphan-stop refusal, TTY-gated token output, and restart, using disposable
  state only — including at least one manual pass against a real disposable
  Docker Postgres container, satisfying the repository's DB-backed-change
  verification requirement without a new automated integration-test lane.


## What to return

Findings only: contradictions, gaps, unstated assumptions, and anything a reader would have to guess. Say what would break and why. Do not record a gate — the coordinating session records it.

The round count below is a FLOOR, not a target. Keep grilling until a round comes back clean AND stays clean on the next one — hitting the floor is not the same as passing.
