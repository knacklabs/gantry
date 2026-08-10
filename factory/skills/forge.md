# Forge — harness operations (canonical body, both runtimes)

Canon lives in `AGENTS.md`, `WORKFLOW.md`, and `harness.yaml`. This skill only
routes to it.

**The contract: devs speak intents; you run the mapped command and report its
output.** A dev should never need to type a `python3 factory/scripts/...`
command themselves. Prompts are the interface, recorder commands are the
contract — every artifact you record must match its `factory/schemas/` file,
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
`python3 factory/scripts/forge.py <cmd>` — either form works everywhere below.

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
| roadmap missing | confirm captured specs, run the project-level decomposition (`factory/prompts/decomposer.md`), then `./forge roadmap derive --input <json>` |
| planning | plan per `factory/prompts/planner.md` (Claude plan mode default, `planner-high` Codex agent alternate); exploration ONLY via `/codex:rescue --model gpt-5.6-terra --effort high` (read-only by default) — never Claude Code itself, never raw codex exec |
| decomposing | run docs-decomposer per task, record with `record_decomposition_from_json.py` (schema incl. `user_facing`) |
| implementing | `./forge delegate <task-id>` composes the brief, launches the companion directly, and records successful launch evidence — the implementer writes and records the tests; user-facing tasks MUST load + attest emil-design-eng + frontend-design in `skills_used` (recorder-enforced; harness.yaml `required_skills`) |
| verifying | `python3 factory/scripts/verify.py` |
| reviewing | ONE autoreview run in Codex, three lenses (`factory/prompts/reviewer.md`) |
| functional-check | only shown when the task is user-facing; run `functional-checker` |
| harvest pending | follow `factory/prompts/harvester.md` |
| anything with a command | run the command verbatim |

## Route by intent

| Dev says | Do |
|---|---|
| set up my machine | `./forge doctor` (`--fix` installs the toolchain; logins stay manual) |
| create a new project / build a new app | prefer the `knacklabs-new-project` skill; without it: `./forge init --name <project> --target <dir>`, then IN `<dir>`: commit and push to its OWN origin (`gh repo create <org>/<repo> --private --source . --push`), `direnv allow`, and open future sessions there. Init writes `.factory/record-origin.json` once so history has an honest starting boundary. The app is a fresh unrelated repo — NEVER fork the harness, NEVER `gh repo create --template`, never build the app inside this clone |
| migrate an existing repo / make this repo symphony-forge ready | `knacklabs-migrate-project` skill — core: `./forge adopt --target <repo>` from the harness clone (clean tree; old AGENTS/CLAUDE preserved to docs/context/; repo keeps its own origin — never fork/merge the harness into it). Adopt creates the same record-origin boundary if absent and never rewrites it. |
| update / upgrade an existing project to the latest harness | prefer the `knacklabs-upgrade-project` skill — it verifies and updates the setup-pinned harness, audits a clean committed client, upgrades machinery, repairs tooling, backfills project contracts, guides pending-story re-authoring with `forge roadmap fill`, re-verifies, and hands off through `forge next` |
| sanitise / check the hygiene of this repo | use the `knacklabs-sanitise-project` skill — run `forge sanitise --check` for an on-demand report or plain `forge sanitise` for safe deterministic fixes, then use the named resolve commands for every reported item needing judgment |
| migrate my gstack history / gstack outputs are on my machine | `./forge gstack migrate` — union-merges ~/.gstack/projects/<slug>/ into the repo's .gstack/ (then commit). Going forward .envrc + `direnv allow` keeps gstack in-repo |
| what's left to build / show the roadmap | `./forge roadmap list` (`--pending` for what's next; grouped by epic, shows @assignee) |
| what can run in parallel / fan out the work | `./forge roadmap parallel` — the dependency-ready frontier, one isolated `git worktree add` + intake per story. Tasks inside each story run sequentially; only separate ready story worktrees run in parallel |
| roadmap merge conflict / duplicate items after merging branches | `./forge roadmap heal` — deterministic union (done-wins); mid-merge it rebuilds from the merge stages, then `git add plans/roadmap.json` |
| grill the handover / stress-test before a gate | `factory/prompts/griller.md` — one question at a time vs the actual docs; resolve findings; record `record_grill_from_json.py --gate spec\|signoff\|epics\|plan`. Spec confirm, sign-off, legacy roadmap import, and plan save refuse without their required fresh pass |
| grill me on this plan | `/grill-me` against the draft plan (satisfies the plan-gate contract), then record `--gate plan` — mandatory before `plan save` |
| capture a capability spec | `./forge spec save <slug> --from <draft.md>`; confirmation requires a digest-bound spec grill, then `./forge spec confirm <slug>` |
| here's the derived project backlog | `./forge roadmap derive --input <json>` (pre-sign-off, every story links a confirmed spec) |
| add a story to the roadmap | `./forge roadmap add <KEY> "<title>" --story "As a <user>, I ... so that ..." --ac "<criterion>" --spec docs/specs/<slug>.md --epic <epic> --skill frontend\|backend\|fullstack [--depends-on <KEY>]` — story and at least one criterion are required |
| an ad-hoc ask arrives mid-project with no spec | same command with `--no-spec --reason "<why>"` — it lands in **Needs spec** as visible debt; `plan save` refuses to build it until `./forge roadmap link-spec <KEY> --spec docs/specs/<slug>.md`. Capture is not authorization (0014) |
| define the team / who's on this project | `./forge team set <handle> --role dev --skills frontend,backend` (optional roster; `./forge team list`) |
| assign a story / distribute work (EM) | `./forge roadmap assign <KEY> --to <dev>` — checked against the roster; match story skill to dev skills |
| who does what / role handoffs | `docs/ROLES.md` — forge next tags every step [PM]/[EM]/[dev] |
| start a task / new feature | `python3 factory/scripts/intake.py --issue <KEY> --title "<title>"` — then check `forge.py context list --pending` BEFORE planning |
| plan is approved | `python3 factory/scripts/forge.py plan save --from <plan-file> --story <key>` (frontmatter attests every active decision) |
| show implementation progress / how far along are we / show the board | `./forge board` — see "Show, don't recite" below. `./forge plan list` is the text fallback |
| review the plan / let me read the plan | open the board at that story: `./forge board` then share `http://127.0.0.1:8765/#<STORY-KEY>`. Its drawer renders the plan with an approval-readiness checklist; approval still happens in chat (the grill is an interrogation, not a button) |
| I need a small fix without a plan | `./forge quickfix start "<reason>"` — a bounded, ledgered window (5 product files) that the hook tracks; close it with `./forge quickfix done`. Exceeding the budget forces plan mode, and pr_ready refuses to ship with a window open |
| why is my edit blocked | the planning lock is ALWAYS armed (decision 0013): product writes need an approved plan or an open quickfix. `.factory/` is never hand-written; recorded state comes from the record_* scripts |
| record the decomposition | `python3 factory/scripts/record_decomposition_from_json.py --input <json>`, then `update_run.py --phase implementing --decomposition-status recorded` |
| record a decision | `./forge decision new <slug>` — draft only; it is stamped with the active story so the board can show which decisions came out of this work |
| this decision also governs another story | `./forge decision link <slug> --story <KEY>` |
| this decision replaces an old one | `./forge decision new <slug> --supersedes <old-slug>` — never edit/delete the old record by hand |
| what decisions are in force | `./forge decision list --active` — the live corpus (superseded records are history) |
| compact the assumptions ledger | `./forge assumptions archive` — resolved rows from finished tasks move to the archive |
| is the repo getting heavy | `python3 factory/scripts/check_repo_budget.py` (CI runs it too) |
| human confirms a decision | acceptance is the HUMAN's call, not their keystroke: on an explicit in-chat confirmation ("accept <slug>", "approved"), run `./forge decision accept <slug> --by "<their name>"` for them; without that statement, relay and wait |
| made an assumption while implementing | `python3 factory/scripts/forge.py plan assume "<one sentence>"` — lands on the active plan AND as an open row in plans/assumptions.md |
| worker hit a contradiction / is confused / blocked / scope shifted | `./forge signal raise --kind <k> --by <agent> -m "..."` then PAUSE — the orchestrator monitors `.factory/signals.jsonl`, resolves, resumes |
| a worker signal is open (orchestrator) | `./forge signal list --open` → `./forge signal resolve <id> --notes "<answer>"` → resume the rescue. Open signals block pr_ready |
| review / guide the assumptions (orchestrator) | `./forge assumptions list --open`, then `./forge assumptions resolve <id> --status confirmed\|fix-needed\|promoted --notes "..."` — pr_ready refuses unguided rows |
| work the next stage / where am I in the task | `./forge stage list` → `./forge stage start <id>` → `./forge delegate <id>` → implement → LOCAL autoreview until clean → commit → `./forge stage done <id>`, which MEASURES the diff and can refuse (WORKFLOW.md Stage Loop) |
| delegate this task / hand it to Codex | `./forge delegate <task-id>` — builds `.factory/briefs/<id>.md`, derives the write flag from stage state, launches the companion without a shell, and records evidence used by `stage done`; `--print-only` is diagnostic and cannot satisfy the gate |
| is Codex stuck? / did it actually do anything | `./forge codex status` — status, phase, write flag and age per job; flags a run that has not moved and a read-only run launched while a stage is active. Advisory, never a gate |
| it only did part of the job | `./forge stage done <id> --incomplete "<what is missing>"` — the stage stays active and the gap enters the timeline |
| are we fixing the same thing again | `./forge findings patterns` — a class at 3+ hits gets a refactor story + decision, never a fourth patch |
| what did we learn about these files | `./forge lesson relevant --files <paths>` — run BEFORE planning/implementing |
| that mistake keeps happening, remember it | `./forge lesson add --topic <slug> --lesson "..." --source <sha/review> --applies-to <globs> --severity low\|medium\|high --by <agent>` |
| this is out of scope for now | `./forge defer add "<item>" --why "..." --trigger "<condition that reopens it>"` — parked scope needs a trigger |
| worth remembering past a compaction (hypothesis, gotcha, in-flight detour) | `./forge note "<one line>"` → .factory/scratchpad.md working notes; the PreCompact hook snapshots deterministic facts above them and PRESERVES the notes. Durable knowledge goes to a lesson/assumption/decision/deferral instead |
| did any deferral come due | `./forge defer list --open` — resolve fired ones back onto the roadmap (`./forge defer resolve <id> --notes ...`) |
| record the test results | `python3 factory/scripts/record_test_from_json.py --kind automated\|functional --input <json>` |
| run verify / does it build | `python3 factory/scripts/verify.py` (never bypass with ad hoc commands) |
| record the review | `python3 factory/scripts/record_review_from_json.py --aspect quality\|performance\|security --input <json>` |
| client signed off | `python3 factory/scripts/record_signoff.py` |
| harvest context / process the dump | follow `factory/prompts/harvester.md`, then `forge.py context mark ...` |
| harness status | read `.factory/run.json`; `forge.py context list --pending`; `ls factory/skills/proposed/` |
| what happened / show project history | `./forge history` reads committed events; add `--story`, `--event`, `--since`, or `--until` to narrow them. Unattributed events remain visible, and the board reports `.factory/record-origin.json` as “record begins here; N commits precede it” when that marker exists. |
| record what the story delivered | `./forge outcome set "<what changed and what someone can now do>"` — one paragraph in a reader's language, required before PR-ready; it lands on the roadmap item and in the ship archive |
| is this PR ready | `python3 factory/scripts/pr_ready.py` (never bypass with ad hoc checks) — a bare run lists what is missing, including the outcome |
| what did we ship last month | open the board's **Ship log** (`./forge board`) — PR-ready date, story, outcome and the decisions it created, newest first |
| mine for skills / retro | follow `factory/prompts/skill-miner.md` |
| improve the animations / motion audit | run the `improve-animations` skill (read-only audit → prioritized plans); land its items via `./forge roadmap add` or a task intake — never apply fixes straight from the audit |
| update a client repo to the latest harness | use the `knacklabs-upgrade-project` skill; its deterministic core is `./forge upgrade --target <client-repo>` from the verified HARNESS clone, followed by client audit/backfill, guided pending-story fill, re-verification, and `forge next` |

## Show, don't recite

When a dev asks anything status-shaped — "what now", "how far along", "show me
progress", "review the plan", "what can we parallelise" — put it on screen
instead of narrating it:

```bash
./forge board            # serves http://127.0.0.1:8765/ and opens the browser
```

- **Reuse, never duplicate.** If the board is already serving this repo, give
  the URL rather than starting a second one; a busy port means it is running.
- Stories are cards on a swimlane board — epic lanes across the lifecycle
  columns — so progress is read from where a card sits, not from prose.
- The board opens on **Overview**: what the project is, what can start now,
  what each epic delivers, and where each story sits. Use
  `./forge board --repo <example>` for a full initialized example repo. The
  checked-in data-only contract sample is discoverable at
  `factory/board/example/`; production validators exercise it, while direct
  serving waits on the deferred board-page resolver change.
- **Deep-link to the story you are talking about**: `…:8765/#RAIL-3` opens that
  story's drawer with its gate rail, what blocks the next gate, and its
  artifacts (plan, spec, decomposition, evidence).
- Specs, decisions, the plans ledger and quickfix history sit behind the
  **Library** panel in the header — reference material, off the main surface.
- **After saving a plan**, hand over the link so the dev reads the rendered
  plan and its approval-readiness checklist instead of the markdown file.
- The board is READ-ONLY on purpose. It shows what blocks approval; it never
  approves. Recording still goes through the gated commands above.
- Still report the outcome in chat — the board supplements your answer, it
  does not replace it.

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
