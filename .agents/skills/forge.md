# Forge — harness operations (canonical body, both runtimes)

Canon lives in `AGENTS.md`, `WORKFLOW.md`, and `harness.yaml`. This skill only
routes to it.

**The contract: devs speak intents; you run the mapped command and report its
output.** A dev should never need to type a `python3 .agents/scripts/...`
command themselves. Prompts are the interface, recorder commands are the
contract — every artifact you record must match its `.agents/schemas/` file,
including `generated_by`. Human-only actions (`decision accept`) need an
explicit human statement — but the human need not type the command: a clear
in-chat confirmation authorizes running it with `--by "<their name>"`.

**Between gates the loop is autonomous (conduct §7).** A clean local review
or a passing gate IS the permission to continue — never stop to ask
"proceed?" after a review, between stages, or across phase transitions.
Report progress and keep driving; stop only for an open signal, a gate
refusal you cannot resolve within the approved plan, a human-only act, or
scope the plan does not cover.

`./forge <cmd>` (from repo root) is shorthand for
`python3 .agents/scripts/forge.py <cmd>` — either form works everywhere below.

## ALWAYS start here

```bash
./forge next
```

That is the deterministic phase engine — it reads run state, the context
ledger, plans, the roadmap, and artifacts, and prints where the project is and
the exact next actions. Never guess the phase yourself; run it, then execute
or route:

| `next` says | Do |
|---|---|
| discovery/prototype | gstack `/office-hours` for the discovery conversation; prototype freely |
| roadmap missing | run the project-level decomposition (`.agents/prompts/decomposer.md`), then `./forge roadmap import --input <json>` |
| planning | plan per `.agents/prompts/planner.md` (Claude plan mode default, `planner-high` Codex agent alternate); exploration ONLY via `/codex:rescue --model gpt-5.6-terra --effort high` (read-only by default) — never Claude Code itself, never raw codex exec |
| decomposing | run docs-decomposer per task, record with `record_decomposition_from_json.py` (schema incl. `user_facing`) |
| implementing | delegate the leaf task (Claude: `/codex:rescue --background`; Codex: `.agents/prompts/implementer.md`) — the implementer writes and records the tests; user-facing tasks MUST load + attest emil-design-eng + frontend-design in `skills_used` (recorder-enforced; harness.yaml `required_skills`) |
| verifying | `python3 .agents/scripts/verify.py` |
| reviewing | ONE autoreview run in Codex, three lenses (`.agents/prompts/reviewer.md`) |
| functional-check | only shown when the task is user-facing; run `functional-checker` |
| harvest pending | follow `.agents/prompts/harvester.md` |
| anything with a command | run the command verbatim |

## Route by intent

| Dev says | Do |
|---|---|
| set up my machine | `./forge doctor` (`--fix` installs the toolchain; logins stay manual) |
| create a new project / build a new app | prefer the `knacklabs-new-project` skill; without it: `./forge init --name <project> --target <dir>`, then IN `<dir>`: commit and push to its OWN origin (`gh repo create <org>/<repo> --private --source . --push`), `direnv allow`, and open future sessions there. The app is a fresh unrelated repo — NEVER fork the harness, NEVER `gh repo create --template`, never build the app inside this clone |
| migrate an existing repo / make this repo symphony-forge ready | `knacklabs-migrate-project` skill — core: `./forge adopt --target <repo>` from the harness clone (clean tree; old AGENTS/CLAUDE preserved to docs/context/; repo keeps its own origin — never fork/merge the harness into it) |
| migrate my gstack history / gstack outputs are on my machine | `./forge gstack migrate` — union-merges ~/.gstack/projects/<slug>/ into the repo's .gstack/ (then commit). Going forward .envrc + `direnv allow` keeps gstack in-repo |
| what's left to build / show the roadmap | `./forge roadmap list` (`--pending` for what's next; grouped by epic, shows @assignee) |
| what can run in parallel / fan out the work | `./forge roadmap parallel` — the unblocked frontier, one `git worktree add` + intake per story; drive each with `/codex:rescue --background`. Fan out WITHIN a task only across disjoint `write_scope` leaf tasks |
| roadmap merge conflict / duplicate items after merging branches | `./forge roadmap heal` — deterministic union (done-wins); mid-merge it rebuilds from the merge stages, then `git add plans/roadmap.json` |
| grill the handover / stress-test before a gate | `.agents/prompts/griller.md` — one question at a time vs the actual docs; resolve findings; record `record_grill_from_json.py --gate signoff\|epics\|plan`. Sign-off, roadmap import, AND plan save REFUSE without a fresh pass |
| grill me on this plan | `/grill-me` against the draft plan (satisfies the plan-gate contract), then record `--gate plan` — mandatory before `plan save` |
| PM approves the epics | `./forge decision new epics-approved` — THE PM runs the accept; roadmap import is refused without it (and without a passing epics grill) |
| here's the project backlog / handoff decomposition | `./forge roadmap import --input <json>` (epics + stories w/ acceptance_criteria + skill) |
| add a story to the roadmap | `./forge roadmap add <KEY> "<title>" --epic <epic> --skill frontend\|backend\|fullstack` |
| define the team / who's on this project | `./forge team set <handle> --role dev --skills frontend,backend` (optional roster; `./forge team list`) |
| assign a story / distribute work (EM) | `./forge roadmap assign <KEY> --to <dev>` — checked against the roster; match story skill to dev skills |
| who does what / role handoffs | `docs/ROLES.md` — forge next tags every step [PM]/[EM]/[dev] |
| start a task / new feature | `python3 .agents/scripts/intake.py --issue <KEY> --title "<title>"` — then check `forge.py context list --pending` BEFORE planning |
| plan is approved | `python3 .agents/scripts/forge.py plan save --from <plan-file>` (plan must follow `.agents/prompts/planner.md`, incl. Decisions section) |
| record the decomposition | `python3 .agents/scripts/record_decomposition_from_json.py --input <json>`, then `update_run.py --phase implementing --decomposition-status recorded` |
| record a decision | `./forge decision new <slug>` — draft only |
| this decision replaces an old one | `./forge decision new <slug> --supersedes <old-slug>` — never edit/delete the old record by hand |
| what decisions are in force | `./forge decision list --active` — the live corpus (superseded records are history) |
| compact the assumptions ledger | `./forge assumptions archive` — resolved rows from finished tasks move to the archive |
| is the repo getting heavy | `python3 .agents/scripts/check_repo_budget.py` (CI runs it too) |
| human confirms a decision | acceptance is the HUMAN's call, not their keystroke: on an explicit in-chat confirmation ("accept <slug>", "approved"), run `./forge decision accept <slug> --by "<their name>"` for them; without that statement, relay and wait |
| made an assumption while implementing | `python3 .agents/scripts/forge.py plan assume "<one sentence>"` — lands on the active plan AND as an open row in plans/assumptions.md |
| worker hit a contradiction / is confused / blocked / scope shifted | `./forge signal raise --kind <k> --by <agent> -m "..."` then PAUSE — the orchestrator monitors `.factory/signals.jsonl`, resolves, resumes |
| a worker signal is open (orchestrator) | `./forge signal list --open` → `./forge signal resolve <id> --notes "<answer>"` → resume the rescue. Open signals block pr_ready |
| review / guide the assumptions (orchestrator) | `./forge assumptions list --open`, then `./forge assumptions resolve <id> --status confirmed\|fix-needed\|promoted --notes "..."` — pr_ready refuses unguided rows |
| work the next stage / where am I in the task | `./forge stage list` → `./forge stage start <id>` → implement → LOCAL autoreview until clean → commit → `./forge stage done <id>` (WORKFLOW.md Stage Loop) |
| are we fixing the same thing again | `./forge findings patterns` — a class at 3+ hits gets a refactor story + decision, never a fourth patch |
| what did we learn about these files | `./forge lesson relevant --files <paths>` — run BEFORE planning/implementing |
| that mistake keeps happening, remember it | `./forge lesson add --topic <slug> --lesson "..." --source <sha/review> --applies-to <globs> --severity low\|medium\|high --by <agent>` |
| this is out of scope for now | `./forge defer add "<item>" --why "..." --trigger "<condition that reopens it>"` — parked scope needs a trigger |
| worth remembering past a compaction (hypothesis, gotcha, in-flight detour) | `./forge note "<one line>"` → .factory/scratchpad.md working notes; the PreCompact hook snapshots deterministic facts above them and PRESERVES the notes. Durable knowledge goes to a lesson/assumption/decision/deferral instead |
| did any deferral come due | `./forge defer list --open` — resolve fired ones back onto the roadmap (`./forge defer resolve <id> --notes ...`) |
| record the test results | `python3 .agents/scripts/record_test_from_json.py --kind automated\|functional --input <json>` |
| run verify / does it build | `python3 .agents/scripts/verify.py` (never bypass with ad hoc commands) |
| record the review | `python3 .agents/scripts/record_review_from_json.py --aspect quality\|performance\|security --input <json>` |
| client signed off | `python3 .agents/scripts/record_signoff.py` |
| harvest context / process the dump | follow `.agents/prompts/harvester.md`, then `forge.py context mark ...` |
| harness status | read `.factory/run.json`; `forge.py context list --pending`; `ls .agents/skills/proposed/` |
| is this PR ready | `python3 .agents/scripts/pr_ready.py` (never bypass with ad hoc checks) |
| mine for skills / retro | follow `.agents/prompts/skill-miner.md` |
| improve the animations / motion audit | run the `improve-animations` skill (read-only audit → prioritized plans); land its items via `./forge roadmap add` or a task intake — never apply fixes straight from the audit |
| update a client repo to the latest harness | from the HARNESS clone: `./forge upgrade --target <client-repo>` (clean tree required; review the diff, run the linter + gate tests, commit) |

## Hard rules

- Implementation is delegated to Codex; planning exploration is Codex
  read-only. See `harness.yaml` for phase owners — it is the ALLOWLIST;
  recorders refuse artifacts from unpinned generators.
- Review is ONE autoreview run — never inline, never nested reviewers.
- Never set a decision to `accepted`, never flip `client_signoff`, never
  activate a proposed skill without an explicit human confirmation — the
  human decides; a clear in-chat statement lets you run the recording
  command with their name.
- If `check_dual_runtime.py` fails, fix the violation it names before anything else.
