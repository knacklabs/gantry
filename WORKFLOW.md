# WORKFLOW.md — Symphony-Style Codex Factory

## Source of Truth
- The repo owns workflow policy, prompts, run artifacts, plans, and decisions —
  it is the canonical state.
- An external tracker (Linear, GitHub Issues, Jira) is OPTIONAL: when one is
  used, roadmap stories are mirrored into it. Decomposition and task state
  remain in the repo under `.factory/decomposition.json` and `plans/`.
- GitHub mirrors branch, PR, checks, and review evidence.
- gstack output is PROJECT-LOCAL: `.envrc` pins `GSTACK_HOME` to
  `<repo>/.gstack` (activate with `direnv allow`), so office-hours design
  docs, the decision store, and learnings are committed under
  `.gstack/projects/<slug>/` — shared by every dev, never stranded in a
  personal `~/.gstack`. Machine noise (sessions, analytics, browser profiles)
  is gitignored; JSONL stores union-merge via the `jsonl-append` driver
  (registered per clone by the SessionStart hook), so concurrent devs never
  conflict. History already in a personal store: `./forge gstack migrate`.
- Product intent lives in `docs/product/BRIEF.md`.
- Architecture and decision docs live in the repo under `docs/architecture/` and `docs/decisions/`.
- Durable project facts live under `docs/memory/`; SessionStart injects its
  `MEMORY.md` index into both runtimes.
- `docs/decisions/` overrides ambiguous or conflicting architecture guidance.

## Runtime Modes
Claude Code coordinates; Codex executes (local sessions and subagents).
The stack is Claude Code + Codex, deliberately: any future
orchestration must produce the same `.factory` artifacts.

### Workflow Modes

- **Full** is the standard workflow: an approved plan proceeds through bounded
  stages, deterministic verification, autoreview, and the remaining gates.
- **Lite** is a human-opened, bounded write window for a small supervised fix:
  `./forge mode lite --by "<name>" --reason "<why>"`. It returns to Full when
  the committed fix is within its file budget, its required review is clean,
  and `./forge mode done` closes the window.

## Factory Phases
0a. `discovery` — lightweight problem, stakeholder, and constraint discovery; no `.factory` ceremony required.
0b. `prototype` — prototype freely and save capability specs as they emerge; no `.factory` ceremony required.
0c. `roadmap` — confirm the specs, then derive epics and stories from them.
1. `planning`
2. `decomposing`
3. `awaiting-approval`
4. `implementing`
5. `testing`
6. `reviewing`
7. `functional-check`
8. `pr-ready`
9. `done` or `blocked`

The sign-off gate sits between roadmap derivation and planning, and it fires
ONCE for the project — not once per task. Recording accepted client sign-off
with `python3 factory/scripts/record_signoff.py` requires at least one
confirmed spec, a derived roadmap with at least one story, and every confirmed
spec referenced by a story. It then PINS that record in `harness.yaml`
(`signoff_record:`), and every gate DERIVES sign-off from the committed pin —
so a fresh worktree with no `.factory/` reads the same answer, and nothing
per-task can re-point it. Re-running on a signed-off project is refused;
changing the pin is a reviewed edit. `update_run.py` and `pre_tool_use.py`
refuse phases at `planning` or later until the pin resolves to an accepted,
human-confirmed record. The per-task human gate is plan approval, not a second
sign-off.

Every handover gate is preceded by a recorded GRILL
(`factory/prompts/griller.md`): an adversarial gaps-and-contradictions
interrogation of what one role hands the next. Confirming each spec requires a
fresh pass bound to that spec. Five scopes are enforced: `spec`, `signoff`,
`epics`, `plan`, and `task`. The first four cover capability confirmation,
client→PM context, the derived backlog, and the story plan. The per-leaf
`task` grill introduced by decision 0032 (JIT task planning) interrogates the
just-authored task contract against the real state left by completed stages.
Its verdict lands in `.factory/grills/tasks/<id>.json` and is bound to the
contract digest over `write_scope`, `required_tests`, `verify_commands`, and
`acceptance_criteria`; a write `forge delegate <id>` refuses a missing,
non-passing, or stale record. Other verdicts land in
`.factory/grills/<gate>.json`. All records go through
`record_grill_from_json.py` (schema-validated, `generated_by: griller`).
Findings must resolve into contract/doc edits or decision records before a
`pass` is recordable.

## Context Inbox & Doc Upkeep

Unstructured context (client emails, transcripts, notes) goes in
`docs/context/` — dumping is free, tracking is mandatory. `forge.py context
scan` registers files in `docs/context/ledger.json` (CI enforces freshness);
an agent following `factory/prompts/harvester.md` turns pending files into
proposed decision records and BRIEF/architecture edits, then marks them
harvested with their outputs (`--ignored` requires notes). Pending context is
surfaced on four channels: the SessionStart hook count, step 1 of
`forge next`, the daily gardener issue, and — the hard stop — `plan save`
refuses while anything is pending. Broader doc freshness
follows `harness/nestjs-react/conventions/doc-gardening.md` (gardening agent —
convention today, not yet automated).

## Repo Hygiene — garbage cannot become contract

Devs will throw everything at the repo (gstack exhaust, old prototypes, raw
text). The doors check what enters; these mechanisms manage what accumulates:

- **Inbox guards**: `context scan` REFUSES files over 5MB and files with
  secret-shaped content (keys, tokens, credentials) — refused files stay
  unscanned, so the plan gate keeps blocking until they're fixed. The inbox
  itself is append-only by design (raw record); agents work from
  `context list --pending`, never by listing the directory.
- **Decision lifecycle**: statuses are `proposed | accepted | superseded` —
  never deleted, never hand-flagged. Replacing a decision goes through
  `forge.py decision new <slug> --supersedes <old-slug>`, which cross-links
  both records; the linter enforces both pointers resolve, that superseded
  records name their successor, and that ACCEPTED records have real
  Context/Decision/Consequences substance (boilerplate is refused). Agents
  read the live corpus via `forge.py decision list --active`; the retro
  (skill-miner) sweeps active decisions for mutual contradictions and
  proposes supersessions.
- **Prototype isolation**: the linter fails any production code importing
  from `prototype/` — reference forever, imported never is enforced, not
  hoped.
- **gstack noise**: derived caches (`brain-cache/`), per-session churn
  (`timeline.jsonl`), and slug caches are gitignored and excluded from
  `gstack migrate`; only design docs, decisions, and learnings are record.
- **Budget watchdog**: CI runs `check_repo_budget.py` — any tracked file
  over 5MB fails, and `docs/context/`, `.gstack/`, `prototype/` have
  cumulative budgets with early warnings. The budget is the backstop for
  the categories nobody predicted.
- **Ledger compaction**: `forge.py assumptions archive` moves resolved rows
  from finished tasks to `plans/assumptions-archive.md` at milestones;
  rejected skill proposals move to `factory/skills/rejected/` (the miner's
  memory — it must not re-propose them without materially new evidence).

## Evolution Loop

Dev corrections are the harness's training data. At retro cadence, an agent
following `factory/prompts/skill-miner.md` mines recurring patterns (3+
occurrences: fix-after-review commits, repeated blockers, superseded
decisions) into PROPOSALS under `factory/skills/proposed/` — skills, memory
lines, or constitution changes, each with cited evidence. Humans promote or
reject; nothing self-activates. The daily `gardener` workflow opens a
GitHub issue whenever unharvested context or unreviewed proposals exist, and
the SessionStart hook surfaces the same counts at the start of every agent
session. The `/forge` Claude skill routes all of this.

## Recurring Findings — a design signal

Review findings accumulate per task (`.factory/history/<issue>/reviews/`;
findings are structured `{category, area, summary}` per the review schema).
`./forge findings patterns` clusters them by class; `forge next` and
`pr_ready` surface any class recorded 3+ times. The rule (decision record
`recurring-findings-escalation`): when the SAME class of issue surfaces more
than twice in one area, STOP patching findings individually — recurring
findings are a design signal, not a fix queue.

- First distinguish a recurring **CLASS** (the same failure shape respawning —
  the dangerous signal) from a converging **TAIL** (distinct real findings,
  severity/count trending down — healthy, keep going). Do not over-escalate
  a tail; do not under-escalate a class.
- **CONSOLIDATE** when the churning area is self-contained and the reviews
  have effectively specified the correct invariant: write the invariant as a
  decision record, add a refactor story to the roadmap (`kind: refactor`)
  that audits every site against it in one pass, and pin it with tests.
- **SPLIT OUT** when the churn exists because the item is entangled with
  other subsystems or is cycle-sized wearing a "quick win" label: remove it
  from the current branch and defer it with an explicit revisit trigger
  (`./forge defer add`).
- Set the tripwire in advance ("if round N still churns X, split it") — in
  the plan or the grill's `open_items` — and HONOR it.

## Loop Health — the watchers are watched

The harness is a graph of improvement loops, and a graph of loops fails in
its own way: circularly, every advisory green while nothing touches reality.
Two rules keep it grounded:

- **The audit loop** (decision `loop-health-audit`): `./forge audit` checks
  the improvement loops themselves — RECURRING classes that keep shipping
  past their escalation with no consolidating decision or refactor story,
  open deferrals past 60 days (re-check the trigger), lessons whose
  `applies_to` globs no longer match any tracked file (a rotted sensor), and
  reviews that stopped emitting structured findings (a blind clusterer). It
  runs at ship cadence (`pr_ready` prints the summary; `forge next` surfaces
  the count) and is ADVISORY: audit output routes work to the roadmap or the
  ledgers — it never blocks the ship that happened to trip it.
- **Calendar cadence** for idle repos: the daily `harness-health` workflow
  runs the audit + integrity check and maintains a "Harness health" issue,
  and — when the vendored harness is behind — runs `forge upgrade` on a
  branch and opens the PR. The harness repo is public: no secret, no setup;
  an unreachable harness degrades to audit-only. The ceiling is fixed:
  automation DETECTS and PROPOSES; merging the upgrade and accepting
  decisions stay human. Nothing self-activates.
- **Frozen gates** (decision `frozen-gate-integrity`): an optimizing loop
  must never tune its own held-out set. `forge init/adopt/upgrade` freeze the
  vendored gate surface (`factory/scripts|schemas|prompts`, `forge`,
  `.claude/settings.json`) into `constitution/VENDOR_MANIFEST.json`;
  `check_vendor_integrity.py` compares, the SessionStart hook warns on drift,
  and `pr_ready` refuses it — a tampered gate invalidates every other gate's
  evidence. Fix direction is always outward: re-vendor via `forge upgrade`,
  or upstream the change to the harness. Never patch gate machinery in place.

## Event-Driven Delegation — signals

Delegation is not fire-and-forget. While a delegated companion runs, the
orchestrator WATCHES `.factory/signals.jsonl` (Claude's Monitor tool on the
file, alongside the companion job status). Stage write launches run in the
foreground; only read-only exploration may run in the background. A worker raises a
signal the moment it hits a `contradiction` (plan vs decision vs doc),
genuine `confusion`, a hard `blocked`, or a `scope-change` — via
`forge.py signal raise --kind <k> --by <agent> -m "<sentence>"` — and PAUSES
that thread instead of guessing. The orchestrator resolves the event
(`forge.py signal resolve <id> --notes "<answer>"` — an answer, a decision
record, or a plan revision) and resumes the worker with the resolution.
Signals are schema-validated (`factory/schemas/signal.json`, attested
`generated_by`), surfaced by `forge next` and the session-start hook, and
OPEN SIGNALS BLOCK `pr_ready` — an unanswered contradiction cannot ship.
The channel is task-scoped: archived to `.factory/history/<issue>/` and
cleaned at ship, like all task evidence.

## Determinism Contract

The rule that decides deterministic vs non-deterministic, once, so nobody
re-derives it per task:

- **Gates, state transitions, and evidence recording are deterministic** —
  scripts under `factory/scripts/`, never skills, never judgment calls.
- **Content generation (plans, code, tests, reviews, harvests) runs on the
  phase's PINNED skills** — `harness.yaml` is the allowlist, not a suggestion.
  Adopting a new tool is a PR to `harness.yaml` + the artifact's schema (then
  `forge upgrade` propagates it), never a local dev choice.
- **The only door into `.factory/` is a recorder** (`record_*_from_json.py`,
  `forge roadmap import`) that validates the payload against its
  `factory/schemas/<artifact>.json` — required fields, types, and a
  `generated_by` value inside the pinned allowlist. Nonconforming payloads
  and unpinned generators are refused outright; there is no override flag.
- **Mandatory phase skills are attested, not assumed.** Each schema's
  `required_skills` names the skills a feature type demands (e.g.
  `user_facing` → `emil-design-eng` + `frontend-design` on the testing
  artifact, `review-animations` on review artifacts); the recorder refuses
  the artifact unless `skills_used` attests them. Advisory skills are listed
  in `skills_used` when used. Same trust model as `generated_by`.
- **Prompts are the interface, recorder commands are the contract.** Devs
  speak intents ("start a task for invoices", "is this PR ready?"); agents
  run the mapped deterministic command. Anything an agent cannot route lands
  on `./forge next`.

Attestation trust model: `generated_by` is declared by the recording agent —
falsifiable, but only deliberately, and it leaves an audit trail (same model
as `plan assume` and decision records).

## Gating Model

Gates are deterministic and run at phase transitions (`update_run.py`,
`record_*` scripts, `pr_ready.py`) and in `pre_tool_use.py` — never on prompt
keywords or turn ends. Under decision 0013, the planning lock is **always
armed**: product writes, including heuristic Bash writes, are refused without
one of three legitimate exits: an approved plan, a bounded ledgered quickfix
window (`./forge quickfix start "<reason>"`), or a bounded ledgered lite window
(`./forge mode lite`). Planning surfaces (`plans/`, `docs/`, `.factory/`,
`factory/`, and `prototype/`) and read-only exploration stay open. Everything
downstream remains enforced at the artifact gates.

Decision 0032 adds a deterministic per-task grill to Full-mode execution. For
each pending leaf the prescribed order is author the contract → re-record the
decomposition → pass the digest-bound `task` grill → `forge stage start`
→ `forge delegate`. `stage start` establishes the measured work boundary;
the write-delegation path is the hard enforcement point and refuses a missing,
non-passing, or stale `.factory/grills/tasks/<id>.json`. Read-only delegation
does not cross that write gate.

The PR boundary has one client-vendored CI contract:
`.github/workflows/roadmap-gate.yml`. On pull requests it requires every
completed work record to be declared — every `done` roadmap story (a done-flip
or newly-added story with added history) and every added work-window done
record — so a single review-driven effort that spans more than one window stays
fully traceable. On pushes to the repository default branch it runs the full
project audit, keeping audit gaps visible. The harness keeps its own internal
implementations for declaration, PR-link recording, and board completeness;
those workflows remain harness-internal rather than part of the vendored
contract. Stories explicitly marked `predates_outcome_contract` still need
history, but are exempt from the newer outcome and link requirements.

## Task Graph Rules
- The planner owns decomposition.
- Decomposition is capability-driven. Its first recording is the ordered task
  LIST: stable ids, titles, objectives, acceptance intent, and dependencies.
  The task list stays in the repo; only stories are mirrored to a tracker.
- Execution-contract detail is authored just in time for the next leaf task,
  against the actual output of its completed dependencies: write scope, exact
  acceptance criteria, verify commands, required tests, and reviewer focus.
  Re-record the decomposition before grilling that contract. Do not guess
  later-task detail during the initial decomposition (decision 0032).
- One task should fit one implementation session and one review package.

## Project Roadmap

`plans/roadmap.json` is the durable, ordered backlog — the role handoff
artifact (see `docs/ROLES.md`). Its epics and stories are derived from
confirmed capability specs before sign-off, never hand-authored. Every story
links its source spec. The roadmap survives every task cycle:
task-scoped `.factory/decomposition.json` is cleared on each intake, but the
roadmap is not. Items carry `story`, `acceptance_criteria`, `epic`, `spec`,
`skill` (frontend|backend|fullstack), and `assignee` (set by
`forge roadmap assign`, validated against the optional `plans/team.json`
roster, preserved across re-imports). Item lifecycle: `pending` → `active`
(set by intake) → `done` (set by `pr_ready.py`, with a link to
`.factory/history/<issue>/`). `forge next` suggests the next pending item
and flags unassigned ones to the EM. Scope changes are PR edits to the
file — future planning refines the roadmap, it does not silently regenerate
it; the per-task plan must satisfy the item's `acceptance_criteria`.
In vendored clients, `.github/workflows/roadmap-gate.yml` arms only when
`constitution/VENDORED_FROM` exists and this roadmap has at least one epic;
an absent or valid epic-less roadmap leaves its gates green, while malformed
roadmap JSON fails the arming step loudly.

## Concurrency — one story per worktree

Run state is branch-scoped by decision (docs/decisions): each story gets its
own isolated worktree and branch (intake names it `feat/<key>-<slug>`), carrying its own committed
`.factory/` state through the loop; `pr_ready.py` archives to
`.factory/history/<issue>/` before merge, so main only ever accumulates
history. One active story per worktree — parallel stories = parallel worktrees.
Roadmap status flips (`active`/`done`) happen on the task branch and merge
normally; the JSONL stores under `.gstack/` union-merge via the
`jsonl-append` driver.

**The orchestrator parallelizes aggressively when requirements separate.**
`depends_on` edges on roadmap items are the deterministic separation signal
(the decomposer derives them from real build-wave dependencies, never blanket
ordering); `./forge roadmap parallel` prints the ready frontier — pending
stories whose dependencies are all done — with a `git worktree add` + intake
command per story. Each worktree is a full checkout on its own branch with
its own `.factory/` state, so every gate (plan mode lock, plan grill,
recorders, ship gate) applies per story, concurrently. Implementations may run
concurrently across those story worktrees. Inside one story, leaf tasks run
strictly in decomposition order with no parallel file edits. Convergence
is designed to be conflict-free: `pr_ready.py` DELETES the task-scoped
`.factory/` state after archiving it (history keeps the record) and reduces
`run.json` to project fields + `last_shipped`, so merging story branches
collides on nothing but `plans/roadmap.json` status flips — and
`./forge roadmap heal` resolves those deterministically (union by key,
further-along status wins; mid-merge it rebuilds from the merge stages).
Commit the archive when `pr_ready` tells you to: evidence that isn't
committed isn't merged.

## Stage Loop — defects never enter history

Recording the initial task list also creates `.factory/stages.json` — the
mutable execution twin of the re-recordable decomposition (decision 0007),
one stage per leaf task in execution order. Decision 0032 makes the pre-work
sequence a JIT contract loop for every pending task:

1. enter plan mode (decision 0029; `factory/prompts/planner.md`) and author the
   next task's full contract against the approved plan and the real repository
   state left by completed dependencies
2. re-record the decomposition with that contract
3. run `factory/prompts/griller.md` with `--gate task`, resolve its findings,
   and record the pass for that id; the recorder derives the current grounding
   digest: `record_grill_from_json.py --gate task --task <id>`
4. save the plan-mode result at
   `.factory/stories/<KEY>/task-plans/<id>.md`, then record the human task-plan
   approval; editing that artifact requires approval again
5. `forge stage start <id>` (strictly order-enforced; task-level `--parallel`
   is refused)
6. `forge delegate <id>` composes the task brief and launches the installed
   companion in the foreground with write access derived from stage state;
   this is the hard gate that refuses a missing, failed, or stale task grill
7. the orchestrator inspects the diff and rejects overbuilt code
8. that stage's assumption rows are validated (`forge assumptions list --open`)
9. smallest relevant checks run
10. **local autoreview on the UNCOMMITTED diff until clean** (`autoreview
   --mode local --max-priority P2`, run DIRECTLY by the orchestrator with the
   autoreview skill — never as a Codex handoff, which re-triggers the same skill
   one indirection deeper). P2, not P0-only: the review enforces the structure
   and validation the contract demanded. Keep the implementation UNCOMMITTED
   through this fix/review loop and commit ONCE when it is clean — committing
   product code mid-loop stales the task grill (its grounding is contract + plan
   + product tree) and the write `forge delegate` refuses until you `git reset
   --mixed HEAD~1`. When a review-driven fix genuinely cannot be verified inside
   the companion sandbox (needs a database/network/Docker it lacks), the
   orchestrator opens a bounded degraded window (`forge mode degraded start
   --reason ...`, allowed mid-stage), makes the MINIMAL host fix, logs it with
   `forge signal raise --kind host-exception`, verifies host-side, and resumes —
   rather than re-delegating an unverifiable guess.
11. commit, then `forge stage done <id>`

`forge next` derives this frontier from the same readiness gate and reports
exactly one of author contract, task grill, stage start, or delegate.

Per-stage local reviews are pre-commit hygiene and record nothing; the ONE
branch-wide autoreview at the review phase remains the only review gate and
sole producer of `.factory/reviews/*` (decision 0001 D6 unchanged — it
catches cross-stage issues the local passes cannot see). `pr_ready.py`
refuses while any stage is not done; `forge next` shows stage progress; the
tracker archives to `.factory/history/<issue>/` at ship.

The loop is AUTONOMOUS between gates (conduct §7): a clean local review IS
the permission to commit and start the next stage — the orchestrator never
pauses to ask "proceed?" after a review or between stages, and the same
holds across phase transitions (verify → review → functional → pr_ready).
It stops only for an open signal, a gate refusal it cannot resolve within
the approved plan, a human-only act, or scope the plan does not cover.

### Who authors what — no ambiguity once implementation starts

After task-plan sign-off, the division of labour is FIXED, so a task never
stalls on "should I do this or hand it to Codex?":

- **Every product change is Codex's, via `forge delegate`.** Not only the
  initial implementation — EVERY fix that diff inspection, the checks, verify,
  or autoreview demand. A one-line config tweak, a dependency bump, a test
  rename, a "trivial" correction: each is a fresh `forge delegate` against the
  same contract, then re-inspect / re-review. The coordinator NEVER edits a
  product file (app code, config, tests, schema, fixtures — anything that lands
  in the committed diff) with its own hands.
- **The coordinator's hands do only orchestration:** author task contracts,
  compose briefs, delegate, run the checks / `verify.py` / required tests, run
  the branch autoreview, record evidence via the `record_*` scripts, commit,
  and — when the story reaches a PR — review that PR.
- **Commit is not a human gate.** A clean local autoreview plus green checks IS
  the permission to commit (conduct §7 autonomy above); the coordinator commits
  and moves to the next stage without pausing for a human "ok to commit?". This
  is what lets an unattended overnight run finish instead of stalling.
- **The one exception — a logged host-exception.** When a required product
  change is PROVABLY impossible in the companion's environment (a sandbox with
  no network, database, or Docker that the change or its verification needs),
  the coordinator may make the MINIMAL change on the host and MUST record why
  with `forge signal raise ... --kind host-exception` (resolve it once done).
  This is bounded and always ledgered — never the default, never silent.

The point: from sign-off to green tests the coordinator has full, deterministic
visibility of what it does versus what it delegates, and only genuine
human-only acts (decisions, sign-off) or unresolvable gate refusals pause it.

## Task Planning
Per-task planning runs in Claude Code plan mode — enforced, not advisory
(decision 0048): the task plan is authored in plan mode (the PostToolUse
hook records its plan-mode marker), then the task grill delivers its rounds
through AskUserQuestion until `frontier_empty`, then a human approves
(`forge task approve --by`), then `stage start`, then `delegate`. A task
plan without a marker, or a grill whose rounds are not in the ledger, is
refused by the recorders. (Exploration
delegated to Codex: `/codex:rescue --model gpt-5.6-terra --effort high` —
read-only by default, never Claude Code itself, never raw `codex exec`; plan
validation, debugging and root-cause runs use `--model gpt-5.6-sol --effort xhigh`,
still read-only); devs may instead use the
`planner-high` Codex agent — the contract is identical either way. The plan follows
`factory/prompts/planner.md`, including the mandatory **Decisions** section: every choice not derivable from BRIEF,
architecture, or existing records becomes a `docs/decisions/` record
(`forge.py decision new`) before decomposition is recorded. Approval means the
plan is in-repo — `forge.py plan save --from <plan-file>` writes
`plans/active/<issue>-<slug>.md`. The draft frontmatter lists every ID from
`forge decision list --active`, and `--story <key>` binds it to the roadmap;
open contradiction signals or incomplete decision coverage refuse the save.
`update_run.py` refuses
`plan_status approved` without it.

During implementation, any call the plan does not cover is recorded the moment
it is made — `forge.py plan assume "<one sentence>"` appends it, dated, under
`## Implementation Assumptions` on the active plan AND as a structured row in
`plans/assumptions.md` (id, date, issue, assumption, status, guidance). The
ledger is the orchestrator's console: it reviews `open` rows and guides each
one — `forge.py assumptions resolve <id> --status confirmed|fix-needed|promoted
--notes "..."`. `pr_ready.py` refuses to ship a task with unguided
(`open`/`fix-needed`) rows; the session-start hook and `forge next` surface
the open count. Promoted assumptions become `docs/decisions/` records. An
assumption that would change scope or acceptance criteria is a report back
to the dev, not an assumption.

## Artifacts
Required run artifacts:
- `.factory/run.json`
- `plans/active/<issue>-<slug>.md` (the approved plan)
- `.factory/decomposition.json`
- `.factory/verify.json`
- `.factory/tests.json`
- `.factory/reviews/quality.json`
- `.factory/reviews/performance.json`
- `.factory/reviews/security.json`

Every evidence artifact is stamped with the commit it was recorded at.
`pr_ready.py` refuses unstamped artifacts, artifacts spanning different
commits, and evidence recorded before the latest code change (commits touching
only `.factory/`, `plans/`, or `docs/` do not invalidate evidence).

On PR-ready, `pr_ready.py` archives the run artifacts to
`.factory/history/<issue>/` and moves the plan to `plans/completed/` — the
durable record of what was decided and what was built.

## Execution Order
1. ensure architecture and decision docs are present in-repo
2. complete discovery; prototype freely and save specs as capabilities emerge
3. confirm every spec, then derive the roadmap from the specs
4. record client sign-off
5. plan one roadmap story and record its ordered task list
6. for each leaf task: author its contract, re-record the decomposition, pass
   the `task` grill, save and approve its per-task plan artifact, start the
   stage, then delegate it; the implementer writes, runs, and records the tests
7. after all stages are done, run ONE branch autoreview pass (three lenses)
   and record the three review artifacts
8. run `python3 factory/scripts/verify.py`
9. run `functional-checker` when the decomposition has `user_facing: true`
10. record the shipped outcome with `./forge outcome set "<what changed>"`
11. run `python3 factory/scripts/pr_ready.py`

## PR Ready Contract
A branch is PR-ready only when:
- plan status is `approved`
- decomposition status is `recorded`
- deterministic verification passes
- automated and functional test artifacts exist with no blockers
- all three review artifacts exist with score >= 8 and no blockers
- acceptance criteria have direct evidence
