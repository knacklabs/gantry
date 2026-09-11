# Cold-read grill — gate: requirements — requirements for cache-bug (docs/specs/cache-bug.md)

You did NOT write what follows. Read it cold, as an adversary trying to break the handover, never as its author defending it. You are READ-ONLY: return findings, change nothing.

## Interrogation technique

Run the interrogation this way. The harness contract above is the floor; this is the technique.

---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

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
- Q: Grill finding 1: decision 0089 pins that every provider turn sees the 30-message channel block plus the thread window. The spec drops that snapshot on resumed sessions. Which way?
  A: Keep 0089, ceiling only (Recommended)
- Q: Grill finding 2: expiring a DeepAgents session starts a fresh thread but leaves the old raw LangGraph checkpoint rows, so Postgres still grows. Reclaim or narrow?
  A: Reclaim on expiry (Recommended)
- Q: Findings 3 to 5 have clear defaults. Confirm all three: threshold is one validated global runtime setting per decision 0025 (not an env var), default 150,000; expiry keys on the max single model-call inputTokens (no cache-read double count); durable memory stays freshly injected on every run and the rule is renamed to no duplicate channel/thread snapshot.
  A: Confirm all three (Recommended)
- Q: Round 2 finding: the one-off rollout invalidation command is a migration/cleanup command, which accepted decision 0003 (early stage, no back-compat) explicitly rejects. How do we handle existing oversized sessions?
  A: Drop the command, rely on unmeasured-means-no-resume (Recommended)
- Q: Round 2 finding: Claude's normalised inputTokens excludes cache read/write tokens and is aggregated per run, so it cannot supply the largest single model-call context. What should the ceiling measure?
  A: New per-request model-visible input maximum (Recommended)
- Q: Confirm the five defaults: scope is every persistent interactive provider session on any channel, jobs excluded; a session without a valid versioned measurement is not resumable, and measurements persist even from failed turns; effective cap is the lower of the global setting (valid range 20,000 to 900,000, applies on next resume) and the runtime-known safe model capacity, unknown capacity does not resume; DeepAgents checkpoint reclamation runs in one shared expiry operation for every expiry reason, never blocks a reply, leaves the session expired if cleanup fails and emits retry evidence; the observability query is operator-only, joins runtime_events to agent_runs to provider_sessions, and shows hashed identifiers by default.
  A: Confirm all five (Recommended)
- Q: Round 3 shows the per-request measurement is not implementable from current adapter output (DeepAgents emits one terminal usage snapshot whose input already includes cache reads; Claude aggregates per run), and the model-capacity clause is unknowable because no model identity is stored on the session. Do you want the minimal scope or the full design?
  A: Minimal: existing per-run usage as the ceiling (Recommended)
- Q: Finding 2: retiring legacy sessions lazily on their next turn is a runtime migration, which decisions 0003 and 0112 reject. How are pre-existing sessions handled?
  A: Manual pre-deploy reset by the owner (Recommended)
- Q: The active cache-bug roadmap card still carries intake-time criteria (drop the snapshot on resume, null Slack handles, update pinned tests) that contradict the grilled spec, and the harness refuses to edit an active card's criteria. How should the two contracts be reconciled?
  A: Link the spec as the card's authority (Recommended)
- Q: Closing question for the spec gate: the other seven findings (typed high-water column per 0017, provider-resolved usage components with partial usage on errors, fenced transition order including reset_at, adapter cleanup port with /new returning references after commit, flat limits scalar with a reader-version bump, event timing with full SHA-256 correlation, and a reset that preserves checkpoint_migrations) are being folded in from what the repository says. Any remaining gap before I amend once and record?
  A: No remaining gap, amend and record (Recommended)
- Q: Requirements gate closing question. The single cold read found seven implementation-shaping gaps (null-safe generation fence, one cumulative partial-usage payload on errors, explicit cache read/write booleans per route with the resolved route carried, /new returning retired references after commit, host-published events with a sanitised error, non-hydrating lost-race re-read per 0078, and aligning two architecture pages with session-resume.md). All seven are answered by the repository. Because the confirmed spec cannot be re-saved without a fresh spec-gate read and that gate's read cap is used up, they become binding plan requirements R1 to R7 rather than spec edits. Any remaining gap before I record the requirements gate and author the plan?
  A: No remaining gap, record and plan (Recommended)
- Q: Plan grill Q1: the compaction-delta replay path already marks a provider session degraded and then expires it when the delta is stale or too large. Decision 0159 wrongly says compaction paths reactivate. What is the contract for that path?
  A: Keep expiry, classify as uncovered (Recommended)
- Q: Do you accept decisions 0158 (retire after observed crossing; contextUsage.totalTokens preferred, derived usage fallback; typed column; global cap setting; no rollout) and 0159 (provider-neutral releaseSession port; /new returns retired references; covered paths ceiling, missing-session, fingerprint, /new; wording corrected per your answer above) so the plan can attest them?
  A: Accept both as Ravi (Recommended)
- Q: Closing question for the plan gate. The other repository-settled corrections will be folded in once: 12 spec criteria plus R1 to R7 mapped to tasks; T1 owns the compaction-delta caller, the service layer that discards resetScope's result, deep-agent-runner.ts, and a typed partial-usage carrier; T3 owns the whole release coordinator, the active /new path in runtime-services-active-new.ts, adapter-registry resolution, and post-reply timing; settings scope adds defaults, YAML renderer, revision document and tests, and the reader-version claim is corrected to what settings-revision-document.ts does today; events carry app and actor context, are best-effort, and get publish, query and projection tests per 0013; a code-owning task adds npm run lint to verify and CI; runtime-components.md and canonical-domain-model.md are named; the SQL recipe gets an executed Postgres test; the non-goal wording becomes no data migration or cleanup flow for pre-existing sessions. Any remaining gap before I amend once, record, and save the plan to the board?
  A: No remaining gap, amend and save (Recommended)
- Q: The harness makes the task count your call before the decomposition is recorded. The approved plan has three sequential backend tasks: T1 measurement and storage (registry booleans, derived input, partial usage on error, typed column with generated migration, fenced raise and retire operations, resetScope references, lint gate); T2 host policy (cap setting with reader-version bump, ceiling preflight with non-hydrating lost-race re-read, post-run raise, two events, docs and recipe, architecture alignment); T3 adapter release port (adapter contract, DeepAgents deleteThread, post-reply coordinator, both /new paths). How many tasks?
  A: Three, as planned (Recommended)
- Q: Task grill finding: both adapters also have inline runtime lanes (agentRuntime 'inline', no spawned worker) that can lose accumulated usage on failure, and T1 only covers the spawned-runner error frames. Cover inline lanes in T1, or narrow the criterion?
  A: Cover inline lanes in T1 (Recommended)
- Q: Closing question for the T1 task gate. The other five findings are repository-answered and will be folded in once: the compaction-delta path keeps the existing expiry helper (ready row, no retirement) per 0159, so three callers switch, not four; the Claude partial usage travels as a typed failure carrier thrown from the result branch and written by runner/index.ts (added to scope) as one error frame; canonical-ops-repo.postgres.ts joins the write scope and resetScope returns a readonly empty list on no-route paths; required tests add both runners' error frames, the caller switches, empty-list propagation, the four pinned tests and verify.py joins verify_commands; T1's acceptance criteria are restated so each is exactly one plan-contract statement, which the recorder requires; the registry type lives in model-provider-registry.ts. Any remaining gap before I amend once, record, and delegate T1?
  A: No remaining gap, amend and delegate (Recommended)
- Q: Run T2 and T3 in parallel worktrees after T1 merges, by moving the runner drain call and both event-type registrations into T2 so T3's write scope is disjoint (adapter contract, DeepAgents adapter, coordinator module, both /new handlers)? This amends the approved graph's dependency T3→T2 to T3→T1.
  A: Yes, amend and run them in parallel (Recommended)
- Q: Closing round for the amended T1 task gate. The cold read's seven findings are folded in from the repo and the session: write scope now names package.json and the three new sibling modules; the lint wording is lint:changed everywhere in the task plan; the diagram routes compaction-delta through the unchanged expire helper per 0159; the derivation criterion names the provider fallback with a new required test; the runtime surface is marked Changed; a required test proves clearSessionForChatJid propagates the retired references; and the stale-state finding resolves itself when the worker's regression fix is re-verified on Node 24. Any remaining gap before I record the gate, re-approve T1 with your name, and resume the worker?
  A: No remaining gap, record and resume (Recommended)
- Q: The pre-tool hook does not govern or claim file-tool writes into a sibling worktree (it resolves the repo root from the session cwd, not the target path). Because of that the degraded window closed with 0 files and stage done refuses. How do you want this handled?
  A: Hotfix the hook + re-apply the fixes under two windows (Recommended)
- Q: `task pr-ready` refuses to open the PR while the two harness hotfixes (review.py proof path, pre_tool_use.py worktree root) sit in the branch, because they drift the vendored gate surface. How should I handle them for the T1 PR?
  A: Revert them in this branch (Recommended)
- Q: Fixing the required-test ids amended T1's contract, so the harness wants a fresh task grill (running now) and a re-approval before the stage can close. May I record the re-approval as Ravi once the grill passes with no open frontier?
  A: Yes, approve as Ravi when clean (Recommended)
- Q: The re-grill found the approved story plan still says all four callers switch to retireProviderSession (decision 0159 §4 keeps compaction-delta on expireProviderSession) and still prescribes blocking full `npm run lint` (settled ruling is `lint:changed` blocking, full lint advisory). The task contracts are already correct — only the plan prose is stale. Editing the plan breaks its approval digest, so it needs a fresh plan cold-read grill plus your re-approval on the board. When should that happen?
  A: After T1 merges, before T2 starts (Recommended)
- Q: Closing round for the re-grilled T1 task gate. All six findings are folded into one amendment: the carrier contract now names DeepAgentPartialUsage as the only shape and states the abort-identity rule (AC2 amended, plus two new required tests — the unit abort seam and the Node-24 boundary _close test, both probed green); QueryFailure's owner corrected to runner/query-failure.exception.ts; the objective and task plan now say lint:changed blocking / full lint advisory; the required-test count corrected to 27; write scope narrowed from the three broad prefixes to the 15 files this task actually touches; the manual error proof replaced with a controlled failure after a usage event; the stale grill record is superseded by this one; and the story-plan contradiction is ledgered as D-0082 to be fixed in the re-ceremony you scheduled between T1's merge and T2's start. Any remaining gap before I record the gate, approve T1 as Ravi, and run the review?
  A: No remaining gap, record and approve (Recommended)
- Q: The quality lens flagged T1-AC9 as only partially implemented — "no blocking CI lint step". It's right about what it was shown, and wrong about the branch. `review.py` builds the bundle by resetting every HARNESS_MACHINERY_PATHS prefix to the task base, and that tuple contains `.github/` (meant for harness-authored workflows, but it swallows a client's own application CI). The synthetic review-tip commit literally reverts our 12-line `lint:changed` CI step before the reviewer sees it — `.envrc` and `package.json` keep theirs because they aren't excluded. So any acceptance criterion needing a CI change is permanently unprovable at review, and re-running reproduces the finding forever. How do you want T1's review closed?
  A: Fold the fix into the hotfix set, re-review (Recommended)
- Q: PR 501's code is green (ci, image, scaffold, hook gates all pass). Only pr-contract fails, because check_task_proof counts per-contract verdicts that no single review chunk can confirm — the brief makes every pass verdict every contract, so each pass guesses about code outside its slice. My merge fix stops blindness outvoting a real verdict, but can't create a verdict when no pass gives one. I've spent three cycles here. How do you want to close it?
  A: Fix the brief: verdict only what you see (Recommended)
- Q: Round 19: the engine complied with the new brief and omitted verdicts for contracts its slice couldn't judge. But `_contract_verdicts` fails an omission closed to `partial`, and record_review_from_json.py turns every partial into a BLOCKING finding — so 'no pass could judge this' is recorded identically to 'this contract is defective'. That conflation is the actual bug, in the recorder rather than the merge logic I patched three times. PR 501's code remains green on CI. Four cycles spent here — how do you want to close it?
  A: Merge 501 now, fix the recorder next (Recommended)
- Q: The grill says the T2 ∥ T3 parallel graph you approved is not independently buildable: T3 needs the cleanup event type and runner drain that T2 owns, so a T3 branch cut from T1 alone cannot typecheck or falsify its ceiling/fingerprint/missing-session proofs. And in the other direction, merging T2 first switches on the default ceiling while the cleanup drain is still a no-op, orphaning DeepAgents checkpoints until T3 lands. How should the graph run?
  A: T3 depends on T2 — run sequentially (Recommended)
- Q: Two runtime surfaces have no task owner. (a) The spec requires `session.provider.retired` after commit for `/new`, but the plan gives all event behaviour to T2, whose scope excludes both /new handlers, while T3 owns the handlers and claims no event work — so cleanup could ship without the required event. (b) D-0083 transfers the resolved DeepAgents route to T2, but T2's plan scope does not include the runner input contract it needs. Who takes them?
  A: T3 takes the /new event, T2 takes the route (Recommended)
- Q: A constitution gap the grill flagged: the coordinator catches cleanup errors and publishes `session.provider.cleanup_failed` best-effort, but nothing specifies a structured fallback log or a publication-failure test. If both the cleanup and the event publication fail, an orphaned checkpoint leaves no evidence at all — which the no-swallowed-errors and structured-logging rules forbid. Separately, the plan says `sha256(id)` without naming which id; hashing the internal provider-session id instead of the raw external-session id would break the documented SQL join.
  A: Require a structured fallback log and name the id (Recommended)
- Q: The plan adds the physical column `context_high_water_mark`, but constitution/pnp-database-standards.md:46 requires camelCase physical columns. Every existing column in this repo is snake_case, so the repo convention looks like a deliberate long-standing deviation — but neither the plan nor any decision records it, so the grill counts it as an undocumented constitution violation.
  A: Record the deviation in a decision (Recommended)
- Q: Closing round for the cache-bug plan grill. Your four decisions are applied: sequential T1->T2->T3; T3 publishes the /new retirement event while T2 takes the resolved-route plumbing; a structured fallback log plus a publication-failure test with the hash named as the RAW EXTERNAL session id; and decision 0160 written and accepted for snake_case columns. The other seven I resolved from the repo: T1's caller list cut to three with compaction-delta explicitly out of scope (0159 §4); T1's write scope corrected to the files that actually shipped, with the compaction call site marked NOT in scope; the partial-usage contract rewritten to what shipped (DeepAgentPartialUsage thrown directly, abort identity preserved, both inline lanes, QueryFailure for Claude); the resolved route marked as NOT delivered by T1; the API surface reclassified Changed with a PUT/GET round trip added to the Verify Plan; and the three parked items recorded as D-0086, D-0087 and D-0088 with triggers. Any remaining gap before I record the pass and save the plan for your approval?
  A: No remaining gap, record and save (Recommended)

## The artifact under interrogation (requirements for cache-bug (docs/specs/cache-bug.md))

---
slug: cache-bug
title: cache-bug — Retire oversized provider sessions across runner restarts
status: confirmed
saved: 2026-09-09T08:45:35+00:00
---

# cache-bug — Retire oversized provider sessions across runner restarts

## Why

Every persistent interactive runner start does two things at once: it resumes
the persisted provider session (which already holds every earlier user,
assistant and tool turn) AND it appends a freshly reconstructed briefing (up to
12,000 characters of durable memory plus up to 16,000 bytes of recent channel /
active thread context) as a new user turn. The per-turn briefing is a pinned
guarantee (decision 0089: every provider turn sees the channel block plus the
thread window; decision 0078: memory hydrates once per turn, with its
session-fence rehydration fallback) and stays as is. What is NOT bounded is
the transcript those briefings accumulate in: nothing expires a provider
session by age, turn count or size — the idle timeout only closes the runner's
stdin, and compaction fires only on explicit `/compact` or when the SDK
reaches the model's context window.

Production evidence (Slack): a one-word turn ("yes") read roughly 270k cached
input tokens on each of two model calls inside one execution (pre-tool and
post-tool), about 541k tokens for the turn. Prompt caching discounts the
repeated prefix; it does not remove it from the context window, stop stale
duplicate briefings reaching the model, or protect against cache misses.

Both execution adapters are affected, differently:

- Claude Agent SDK: model-visible context grows linearly until SDK autocompact
  at the context window (≈1M on the deployed model). Cost and latency grow.
- DeepAgents / LangChain: the library summarises at ~85% of a known window, so
  model-visible history is bounded, but the LangGraph Postgres checkpoint keeps
  the raw state, so checkpoint tables and checkpoint load latency grow instead.
  No application path owns checkpoint deletion.

Scheduled jobs already run non-persistent sessions on both adapters and are
out of scope. The runner is channel-neutral, so this applies to every channel
that holds a persistent interactive session, not only Slack.

Discovery: read-only Codex run `task-mttrhe3o-xh5mh1` (2026-09-09), plus the
Claude-adapter trace in `apps/core/src/runtime/group-agent-runner.ts`,
`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop-phases-setup.ts`
and `apps/core/src/adapters/storage/postgres/repositories/canonical-session-repository.postgres.ts`.

Grill resolutions (spec gate, 2026-09-09; human decisions in rounds 1–5,
final cold read amended once per the one-read rule):
- Keep 0089 and 0078 unchanged; contain growth with a session-size ceiling
  only (a delta snapshot on resume is parked).
- MINIMAL scope: the ceiling uses per-run usage the adapters already report,
  corrected for provider cache semantics (`totalBillableInputTokens` subtracts
  cache reads and would never catch the 270k case). No per-request seam, no
  model-capacity clause, no retry system.
- This is a **retire-after-observed-crossing** rule, not a hard bound.
- Threshold is one global revisioned runtime setting per decision 0025.
- DeepAgents checkpoint rows are reclaimed through an adapter cleanup port on
  the named retirement paths only; orphans are an operator procedure.
- Pre-existing sessions are retired by a manual pre-deploy reset run by the
  deployment owner (decisions 0003 and 0112): no shipped command, no lazy
  retirement, and a deployment stop condition.
- Roadmap card: the acceptance criteria captured on `cache-bug` at intake
  predate grill convergence and the harness does not edit an active card's
  criteria. Human decision (round 5): this confirmed spec is LINKED to the
  card and is the story's authority; the intake criteria are superseded by
  the acceptance criteria below.

## Behaviour

1. **Model-visible input per run.** The host derives
   `modelVisibleInputTokens` from provider-resolved usage components of a
   run. The provider registry entry that already names the cache usage
   fields gains two booleans, `cacheReadsIncludedInInput` and
   `cacheWritesIncludedInInput`:
   - Anthropic (`cache_read_input_tokens`, `cache_creation_input_tokens`
     additive to `input_tokens`): both false →
     `inputTokens + cacheReadTokens + cacheWriteTokens`;
   - OpenAI-compatible (`prompt_tokens_details.cached_tokens` ⊆
     `prompt_tokens`): reads true, writes n/a → `inputTokens`;
   - no cache accounting → `inputTokens`.
   Mixed-provider or unresolved-provider usage uses the additive (largest)
   form; over-approximation only retires sooner. Each adapter must surface
   the usage it has accumulated so far on an error frame (Claude: the error
   path in `query-loop-phases-messages.ts` currently emits none; DeepAgents:
   the terminal snapshot), so costly errored turns cannot evade retirement.
   Because usage is per run, the figure over-approximates a single call's
   context; accepted for a retirement trigger. Billing fields and
   `totalBillableInputTokens` are unchanged.
2. **Typed per-session high-water mark, atomic and fenced.** A new nullable
   integer column `provider_sessions.context_high_water_mark` (decision 0017:
   resume-governing state is a typed column, never `metadata_json`). A new
   repository operation `raiseProviderSessionContextHighWaterMark({
   providerSessionId, agentSessionId, agentSessionResetAt, value })` runs one
   `UPDATE ... SET context_high_water_mark = GREATEST(COALESCE(existing, 0),
   value)` whose predicate fences on provider-session id, `agent_session_id`
   ownership, a resumable status, and `agent_sessions.reset_at` equal to the
   caller's generation, and returns whether a row changed. A non-integer or
   negative `value` is rejected before SQL. It is called after any run
   (including an errored run) whose output carries usage; runs without usage
   do not call it. The turn context projection returns
   `contextHighWaterMark` alongside the existing provider-session fields.
3. **Retire on resume when over the cap.** Preflight order: promote a
   `ready` row first (existing behaviour), then evaluate the mark on the
   selected row. If it exceeds the cap and the row is `active`, retire it via
   behaviour 5 and start a fresh session from the ordinary bounded briefing.
   A `maintenance_compact` row is never retired by the ceiling; it resumes
   or waits as today. Sessions at or under the cap, with no mark, or in
   maintenance resume exactly as today. The preflight adds no hydration
   beyond what 0078 specifies. Allowed overshoot: the one run that first
   exceeds the cap; the *next* resume retires it.
4. **Cap setting.** Canonical desired-state path
   `limits.provider_session_max_input_tokens`, a global scalar accepted by
   the strict limits parser alongside the existing flat
   `limits.<providerId>.requests_per_minute` entries; integer in
   20,000–900,000, default 150,000 when absent; rendered by the existing
   settings exporter; importable and exportable through the same YAML and
   control-API surfaces as `limits`; distributed through
   `settings_revisions`. Because the strict parser rejects unknown keys,
   `CURRENT_SETTINGS_READER_VERSION` is bumped and revisions carrying the key
   set that `min_reader_version`, so an older worker holds its prior revision
   and alerts (0025 skew contract) instead of failing. A lowered value takes
   effect on the next resume evaluated by a worker that has applied that
   revision. No environment variable, no per-agent override.
5. **Atomic retirement returning the retired reference.** A NEW
   `retireProviderSession` is one atomic `active`→`expired` transition
   fenced on provider-session id, `agent_session_id` ownership, status
   `active`, and `agent_sessions.reset_at`; it returns the retired
   `{ providerSessionId, externalSessionId, executionProviderId }` or nothing
   if no row transitioned. The existing `expireProviderSession` REMAINS for
   the compaction-delta degradation path, which operates on a `ready` row and
   is unchanged: no release, no retirement event (0159 §4). Three callers move
   to the new operation — the access-fingerprint change, the missing-session
   retry, and the ops-service facade.
   On a lost transition the host re-reads the turn
   context and proceeds with what it finds; it does not persist a replacement
   handle for a generation it does not own. Covered retirement paths:
   ceiling (new), missing-session, access-fingerprint change, and `/new`,
   whose reset selects the scoped provider-session references inside its
   transaction and hands them to cleanup only after commit. Explicitly NOT
   covered (retention stated): normal handle replacement (deletes the prior
   row without cleanup; DeepAgents thread ids are stable across runs so this
   is rare), agent and workspace removal cascades, and compaction failure or
   cancellation paths, which today reactivate the session and promise
   continuity to the user and keep doing so. Orphans from uncovered paths
   are the operator procedure in behaviour 7.
6. **Adapter cleanup port.** The execution-adapter contract gains an optional
   `releaseSession({ externalSessionId, runtimeStorage })` capability; the
   host calls it from a non-empty retirement result, passing the same
   `runtimeStorage` it passes to `prepare()`, after the reply path is
   unblocked. The DeepAgents adapter implements it by deriving the checkpoint
   schema exactly as `prepare()` does and calling the saver's
   `deleteThread(externalSessionId)`, which removes that thread's rows from
   `checkpoints`, `checkpoint_blobs` and `checkpoint_writes`; it is
   idempotent and on failure emits the cleanup-failed event of behaviour 8
   and leaves the session expired. The Claude adapter does not implement it.
   Core runtime stays provider-neutral: it never names a checkpoint table.
7. **Briefing, jobs, and operator procedures.** Every turn still receives
   the memory block and channel/thread snapshot exactly as 0089 and 0078
   require. Scheduled jobs are untouched. `docs/memory/` records:
   (a) the deployment owner's pre-deploy reset — drain live traffic, stop
   workers, select the interactive provider sessions (rows whose agent
   session has no `job_id` and a resumable status), delete the DeepAgents
   rows for exactly those `external_session_id`s from `checkpoints`,
   `checkpoint_blobs` and `checkpoint_writes` (never
   `checkpoint_migrations`), delete those provider-session rows, verify zero
   resumable interactive rows, then deploy; deploying with resumable
   interactive rows present is a stop condition because those sessions carry
   no mark and will resume normally; (b) the orphan reclamation procedure
   driven by cleanup-failed events and the uncovered paths in behaviour 5.
8. **Observability events.** Two registered runtime event types.
   `session.provider.retired` (payload: `reason` ∈ {ceiling, fingerprint,
   missing, new}, `providerSessionHash`, `executionProviderId`,
   `contextHighWaterMark`, `cap`) — for ceiling and fingerprint it is
   published at preflight with envelope `sessionId = agentSessionId` and no
   run id; for missing-session it is published after the failed attempt with
   that attempt's `runId`; for `/new` after commit with `sessionId`.
   `session.provider.cleanup_failed` (payload: `providerSessionHash`,
   `executionProviderId`, `error`). `providerSessionHash` is the full
   lowercase hex SHA-256 of the raw external session id, and the recipe joins
   with `encode(sha256(external_session_id::bytea), 'hex')`.
9. **Observability recipe.** An operator-only read-only SQL recipe in
   `docs/memory/`: per provider session (hashed), the typed mark and the
   per-run `model.usage` series via `agent_runs` LEFT JOIN `runtime_events`
   ordered by `agent_runs.started_at`, unioned with `session.provider.retired`
   events by hash and `agent_session_id`; plus DeepAgents checkpoint-table
   row counts per hashed thread id in the derived checkpoint schema.

## Acceptance criteria

1. Unit tests: `modelVisibleInputTokens` for an Anthropic usage of 1,000
   input / 270,000 cache read / 500 cache write is 271,500; for an
   OpenAI-compatible usage of 1,000 input / 800 cached is 1,000; a
   mixed-provider usage uses the additive form; billing fields unchanged.
2. Adapter tests: an errored Claude run and an errored DeepAgents run each
   surface the usage accumulated before the error.
3. Repository tests (Postgres): the raise operation keeps the larger value,
   leaves `metadata_json` untouched, rejects a stale owner, rejects a stale
   `reset_at` generation, ignores non-resumable rows, rejects invalid values
   before SQL, and reports whether a row changed; the migration adds the
   typed column.
4. Unit tests (host): a usage-bearing errored run raises the mark; a run
   with no usage does not call the operation.
5. Unit tests: a session with a mark over the cap is not passed as the resume
   id; retirement returns the reference; the run proceeds without resume; the
   replacement handle is persisted; the reply is delivered. A session whose
   run crosses the cap is retired on the following resume, not mid-run. A
   `maintenance_compact` row over the cap is not retired. A `ready` row is
   promoted before evaluation. A lost transition persists no replacement.
6. Unit test: a session at or under the cap, or with no mark, resumes and
   still carries the memory block and snapshot. Existing tests pinning that
   (`group-processing.test.ts` "passes hydrated memory context with provider
   session resume id", `agent-runner-ipc.test.ts` live-turn persist/resume,
   `claude-agent-sdk-boundary.integration.test.ts` memory+prompt user
   message, `deepagents-memory-context.test.ts`) stay green and untouched.
7. Settings tests: `limits.provider_session_max_input_tokens` parses next to
   provider entries, defaults to 150,000 when absent, rejects values outside
   20,000–900,000 with a path-level error, round-trips through export, is
   applied from a new revision by a current worker, and a worker below the
   bumped reader version holds its prior revision and alerts.
8. Postgres integration test (DeepAgents, using the existing
   `deepagents-checkpoint.postgres.integration.test.ts` harness and its
   isolated schema fixture): for ceiling, missing-session, fingerprint and
   `/new` paths, the retired thread's rows are removed from all three tables,
   `checkpoint_migrations` and other threads' rows remain; a second call is a
   no-op; a simulated deletion failure leaves the session expired, the reply
   delivered, and a `session.provider.cleanup_failed` event recorded; a lost
   retirement transition performs no cleanup.
9. Unit tests: `session.provider.retired` is emitted with the specified
   payload and timing per reason, carries `sessionId` or `runId` as stated,
   and is not dropped by event forwarding.
10. Scheduled-job tests are untouched and green.
11. `verify.py` green.
12. Both operator procedures and the observability recipe exist in
    `docs/memory/`, and the query runs against the current schema.

## Non-goals

- Changing what a turn's briefing contains (0089, 0078) or its limits. A
  delta snapshot on resume is parked: revisit if retirement alone leaves
  turns too expensive.
- A per-model-request context measurement or a model-capacity-aware cap
  (parked; revisit if the per-run figure proves too coarse).
- A hard mid-run bound; this rule retires after an observed crossing.
- Replacing cross-process resume with briefing-only reconstruction.
- Any shipped migration, cleanup, or lazy-retirement behaviour for
  pre-existing state (0003, 0112).
- Cleanup on handle replacement, agent/workspace removal cascades, or
  compaction failure paths; and any durable cleanup retry system.
- Fixing the DeepAgents usage normaliser's largest-not-summed billing
  accounting (separate defect; recorded as a deferral).


## What to return

Findings only: contradictions, gaps, unstated assumptions, and anything a reader would have to guess. Say what would break and why. Do not record a gate — the coordinating session records it.

The round count below is a FLOOR, not a target. Keep grilling until a round comes back clean AND stays clean on the next one — hitting the floor is not the same as passing.
