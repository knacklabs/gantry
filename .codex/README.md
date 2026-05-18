# `.codex/` — Gantry Agent Harness

This directory is the **Codex agent harness**. It is the contract that turns a
Codex/ACP session (or any compatible runner) into a disciplined factory:
plan → decompose → implement → test → review → functional check → PR-ready.

If you are about to contribute, read this once end-to-end. The harness is what
keeps multiple humans and multiple agents from stepping on each other.

> Companion docs: top-level [`AGENTS.md`](../AGENTS.md), [`WORKFLOW.md`](../WORKFLOW.md),
> [`docs/FACTORY.md`](../docs/FACTORY.md), [`docs/QUALITY.md`](../docs/QUALITY.md).

---

## 1. Mental Model

Three things move through the harness on every change:

1. **Run state** — a single `.factory/run.json` describes the active issue,
   current phase, and per-step status. Every agent reads it before acting.
2. **Stage playbook** — `scripts/stage_playbook.py` maps each phase to a goal,
   the required subagent(s), the prompt contract, and the deterministic
   commands that must run to advance.
3. **Artifacts** — every phase writes a structured JSON/Markdown record under
   `.factory/`. Gates refuse to mark a run PR-ready until the required
   artifacts exist and pass thresholds.

Codex hooks (`hooks.json`) inject this context into every session and prompt,
so a fresh agent always knows what phase it is in and what is expected next.

---

## 2. Directory Layout

```
.codex/
├── AGENTS.md                  # operating rules for *this folder* (prompt layer)
├── README.md                  # you are here
├── config.toml                # Codex personality, sandbox, agent limits
├── hooks.json                 # SessionStart / UserPromptSubmit / PreToolUse / Stop wiring
├── rules/default.rules        # Codex-native command policy
├── architecture-map.json      # owned layers, line budgets, provider patterns
├── architecture-exceptions.json # narrow time-bounded waivers (keep small)
├── lessons.jsonl              # append-only architecture lessons
├── review-instructions.md     # checklist for big architecture/runtime reviews
│
├── agents/                    # subagent definitions (one TOML per role)
├── prompts/                   # prompt contracts each agent must satisfy
├── skills/                    # invocable skill cards (architecture-refactor, etc.)
└── scripts/                   # all factory scripts: hooks, gates, recorders, checks
```

`.factory/` (sibling, not inside `.codex/`) is where this harness writes
generated artifacts. See [`.factory/README.md`](../.factory/README.md).

---

## 3. The Factory Phases

Defined in `scripts/stage_playbook.py`. Each phase has a fixed goal, agents,
prompt contract, and transition rule:

| Phase              | Goal                                                   | Agent(s)                                                        | Output artifact                       |
| ------------------ | ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------- |
| `planning`         | Approved, decision-complete plan                       | `planner-high`                                                  | plan in repo + `run.plan_status`      |
| `decomposing`      | Capability-driven, bounded task graph                  | `docs-decomposer`                                               | `.factory/decomposition.json`         |
| `awaiting-approval`| Human checkpoint                                       | —                                                               | `run.plan_status=approved`            |
| `implementing`     | Land one bounded leaf task                             | (parent agent)                                                  | code diff                             |
| `testing`          | Automated tests + deterministic verify                 | `automated-tester`                                              | `.factory/tests.json`, `verify.json`  |
| `reviewing`        | Parallel quality / performance / security review       | `quality-reviewer`, `performance-reviewer`, `security-reviewer` | `.factory/reviews/{quality,performance,security}.json` |
| `functional-check` | User-visible behavior validation                       | `functional-checker`                                            | `.factory/tests.json` (functional)    |
| `pr-ready`         | Enforce all gates, package PR                          | —                                                               | `validation-report.json`              |
| `done` / `blocked` | Terminal states                                        | —                                                               | —                                     |

To see what the active run expects right now:

```bash
python3 .codex/scripts/stage_orchestrator.py
# or as JSON:
python3 .codex/scripts/stage_orchestrator.py --json
```

---

## 4. Subagents

Each file under `agents/` is a Codex subagent definition: name, model,
reasoning effort, sandbox mode, and the developer instructions it must obey.

| Agent                   | Sandbox          | Used in phase            | Returns                                     |
| ----------------------- | ---------------- | ------------------------ | ------------------------------------------- |
| `planner-high`          | `read-only`      | `planning`               | Plan with the 7 mandated sections           |
| `docs-decomposer`       | `read-only`      | `decomposing`            | JSON task graph (epics, tasks, build waves) |
| `automated-tester`      | `workspace-write`| `testing`                | JSON test report                            |
| `quality-reviewer`      | `read-only`      | `reviewing` (parallel)   | JSON review (score, findings, recommendation) |
| `performance-reviewer`  | `read-only`      | `reviewing` (parallel)   | JSON review                                 |
| `security-reviewer`     | `read-only`      | `reviewing` (parallel)   | JSON review                                 |
| `functional-checker`    | `workspace-write`| `functional-check`       | JSON functional report                      |

Output contracts are mirrored in `prompts/*.md` and validated in
`scripts/factory_gates.py`. Reviewers are spawned **in parallel** per
`prompts/review-orchestrator.md`; if a subagent returns prose instead of the
required JSON shape, make it restate it before recording.

---

## 5. Hooks (`hooks.json`)

Codex calls these scripts at fixed lifecycle points. Each prints a JSON
payload Codex consumes; never print stray text.

| Event             | Script                          | Effect                                                                                          |
| ----------------- | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SessionStart`    | `scripts/session_start.py`      | Injects factory mode, active issue/phase, and stage context into the session.                   |
| `UserPromptSubmit`| `scripts/user_prompt_submit.py` | Re-injects stage context on every user prompt; can **block** implementation requests when `FACTORY_ENFORCE_INTAKE=1` and intake/plan/decomposition are missing. |
| `PreToolUse(Bash)`| `scripts/pre_tool_use.py`       | Denies destructive commands (`rm -rf`, `git reset --hard`, `git push --force`, `terraform destroy`, `kubectl delete`). Silent on allow. |
| `Stop`            | `scripts/stop_continue.py`      | No-op today. Real PR-readiness enforcement lives in `validate_work.py` / `pr_ready.py`.         |

Keep hooks fast, adaptive, and silent on the happy path. Heavyweight policy
belongs in `rules/default.rules` (Codex-native) or in the explicit gate scripts.

---

## 6. Scripts You Will Actually Run

All scripts live under `scripts/` and use `factory_lib.py` for shared helpers.
Common entry points:

### Run lifecycle

```bash
# Start a new factory run from a Linear issue + title
python3 .codex/scripts/intake.py --issue ENG-123 --title "Feature title"

# Show what the current phase expects
python3 .codex/scripts/stage_orchestrator.py

# Update phase or status fields on .factory/run.json
python3 .codex/scripts/update_run.py --phase reviewing
```

### Recording artifacts

```bash
python3 .codex/scripts/record_decomposition_from_json.py --input /tmp/decomposition.json
python3 .codex/scripts/record_test_from_json.py     --kind automated   --input /tmp/automated-test.json
python3 .codex/scripts/record_test_from_json.py     --kind functional  --input /tmp/functional-test.json
python3 .codex/scripts/record_review_from_json.py   --aspect quality   --input /tmp/quality.json
python3 .codex/scripts/record_review_from_json.py   --aspect performance --input /tmp/performance.json
python3 .codex/scripts/record_review_from_json.py   --aspect security  --input /tmp/security.json
```

### Verification & gates

```bash
# Full deterministic verification: format -> build -> architecture ->
# runtime-truth -> python tests -> typecheck -> npm test -> e2e
python3 .codex/scripts/verify.py

# Just the architecture fitness checks (layers, providers, line budgets, terms)
python3 .codex/scripts/check_architecture.py

# Validate factory artifacts against gate thresholds
python3 .codex/scripts/validate_artifacts.py --allow-missing-run

# Full PR-ready harness: verify + gates + pr_ready
python3 .codex/scripts/validate_work.py

# Mark the run PR-ready when every gate passes
python3 .codex/scripts/pr_ready.py
```

### Knowledge & sync

```bash
# Append a durable architecture lesson (deduped, validated)
python3 .codex/scripts/record_lesson.py \
  --topic "permission safety" \
  --lesson "Risky tool execution must pass through deterministic permission evaluation." \
  --source "review: PR #123" \
  --severity high \
  --applies-to "apps/core/src/runtime/**" \
  --applies-to "apps/core/src/runner/**"

# Push a comment or state change to Linear (needs LINEAR_API_KEY)
python3 .codex/scripts/sync_linear.py --issue ENG-123 --comment "Decomposition recorded."

# Verify the harness scaffold is intact
python3 .codex/scripts/check_factory_scaffold.py
```

### Tests for the harness itself

The harness ships its own Python tests:

```bash
python3 -m unittest discover .codex/scripts/tests
```

These run inside `verify.py` so prompt/policy regressions are caught.

---

## 7. Hard Gates (must pass before merge or release)

From `AGENTS.md`:

```
npm run build
npm test
python3 .codex/scripts/verify.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
```

Full factory mode also requires:

```
python3 .codex/scripts/validate_work.py
python3 .codex/scripts/pr_ready.py
```

Gate thresholds (see `scripts/factory_gates.py`):

- All three reviews must have **score ≥ 8**, no `blocking_findings`, and a
  recommendation in `{approve, approve-with-caveats, changes-required}`.
- Functional testing must be **score ≥ 8** with status `passed` or `partial`
  and zero blockers.
- Automated testing must have status `passed` or `partial` and zero blockers.
- `verify.json.ok` must be `true` with non-empty `results`.
- `decomposition.json` must contain at least one task.

---

## 8. Architecture Fitness (`check_architecture.py`)

Reads `architecture-map.json` and enforces:

- Layer import rules (`domain` cannot import adapters/runtime/etc.).
- Provider-specific imports allowed only inside approved adapter paths.
- Anthropic/Claude provider-boundary tokens outside the approved adapter
  boundary, with exact-count debt tracked in `provider-boundary-exceptions.json`.
- Per-file line budgets (`defaultLineBudget = 700`, with named overrides).
- Forbidden patterns: direct provider sends, IPC monoliths, runtime
  materialization in runner code, browser default-profile paths, old terms
  (`groupFolder`, `mainGroup`, `registeredGroup`, `claude-only`).
- Wrapper-only files and empty folders.
- Doc references to retired files.

**Architecture exceptions are time-bounded ratchets.** Add to
`architecture-exceptions.json` only with `file`, `rule`, `reason`, and
`removeByPhase`. File line-budget violations cannot be excepted. Stale or
over-capped exceptions fail the check.

Anthropic/Claude provider-boundary exceptions live separately in
`provider-boundary-exceptions.json`. They must use exact file paths and exact
token counts; changing a count without updating the exception fails the check.

---

## 9. Skills

`skills/<name>/SKILL.md` are invocable skill cards. Use them when a task
matches their domain — they encode the read-this-first docs and the verify
commands for a class of change.

| Skill                   | When to invoke                                                    |
| ----------------------- | ----------------------------------------------------------------- |
| `architecture-refactor` | Folder moves, layer ownership, domain↔adapter boundary changes   |
| `permission-safety`     | Tool execution, sandbox, browser, IPC permission flows            |
| `provider-adapter`      | LLM / channel / browser / sandbox provider integrations           |
| `schema-change`         | Postgres schema, migrations, repository contracts                 |

Each skill's "Required Workflow" lists the docs to read and the gate scripts
to run before handoff. Don't skip them — they exist because we got burned.

---

## 10. Lessons (`lessons.jsonl`)

Append-only, JSON-per-line, validated by `record_lesson.py`. Each entry has
`topic`, `lesson`, `source`, `addedAt`, `appliesTo` (path globs), and
`severity` (`low|medium|high`).

Add a lesson after a repeated failure or a non-obvious review finding so the
next agent does not re-learn it. `select_relevant_lessons.py` pulls the
relevant subset by path glob.

---

## 11. How To Add A Phase, Agent, Prompt, Or Hook

- **New subagent** — drop a TOML in `agents/`, mirror its output contract in
  `prompts/`, reference it from `stage_playbook.py` if it owns a phase, and
  add the file to `check_factory_scaffold.py`.
- **New prompt contract** — add a Markdown file in `prompts/`. Keep it
  decision-complete; no generic process padding (see `AGENTS.md`).
- **New hook** — wire it in `hooks.json`, keep the script fast (`timeout`
  budgets are tight), emit JSON only.
- **New gate threshold** — extend `factory_gates.py`, add unit coverage in
  `scripts/tests/`, and update this README's hard-gates section.

After any prompt/policy change, run:

```bash
python3 -m unittest discover .codex/scripts/tests
python3 .codex/scripts/check_factory_scaffold.py
```

---

## 12. Conventions Multiple Contributors Need To Agree On

- **One run at a time.** `.factory/run.json` is the single source of truth.
  If a new request comes in mid-PR-ready, run `intake.py` for the new scope
  rather than mutating the active run.
- **Artifacts are write-only from agents, read-only from gates.** Use the
  `record_*` scripts; never hand-edit `.factory/*.json`.
- **`settings.yaml` is the restart source of truth** for agent identity,
  capabilities, conversations, sender policies, approvers, triggers, and
  bindings. Postgres mirrors. See top-level `AGENTS.md` for the full rule.
- **Refactors delete legacy** — Gantry is pre-launch; do not add
  compatibility shims, migration commands, or auto-cleanup branches just to
  preserve old local state.
- **Update the AGENTS.md in the folder you touched** with anything you had to
  re-learn. That, plus `lessons.jsonl`, is how the harness gets smarter.
