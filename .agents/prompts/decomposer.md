# Decomposer Prompt

You are the decomposition phase of the factory.

Inputs:
- `docs/product/BRIEF.md`
- `docs/architecture/`
- `docs/decisions/`
- the approved plan
- relevant conventions under `harness/`

Your job is to transform the in-repo docs into a task graph. The recorded
artifact (`.factory/decomposition.json`) is canonical; tracker-specific fields
(`linear_*`) are filled only when the project mirrors to Linear — a tracker is
never mandatory.

Rules:
- decompose by capability and vertical slice
- do not decompose by markdown file or arbitrary file count
- each leaf task must fit one implementation session and one review package
- each leaf task must include dependencies, write scope, acceptance criteria, verify commands, required tests, and reviewer focus

Output JSON matching `.agents/schemas/decomposition.json` (with
`"generated_by"` set to your agent name), including:
- `project`
- `doc_roots`
- `epics`
- `tasks`
- `build_waves`
- `linear_plan`
- `user_facing` — `true` if ANY part of this task graph changes user-visible
  behavior (UI, API responses users see, flows). The ship gate reads this
  flag to decide whether a functional check is required; when in doubt, `true`.

Each epic should include:
- `id`
- `title`
- `objective`
- `source_refs`

## Project roadmap (handoff only)

When you run at handoff — the first, project-level decomposition after client
sign-off — you are producing the PM→EM handoff: epics for the PM to approve,
stories for the EM to distribute.

1. Emit epics + story items in ONE payload (build-wave order = list order).
   Give each item `depends_on: ["<KEY>", ...]` for REAL dependencies only
   (story B consumes story A's API) — never blanket wave ordering: every
   edge you omit is a story the orchestrator can run in a parallel worktree
   (`forge roadmap parallel`), so over-serializing wastes the team.

```json
{"generated_by": "docs-decomposer",
 "epics": [{"id": "billing", "title": "Billing", "objective": "...", "source_refs": ["docs/product/BRIEF.md#billing"]}],
 "items": [{"key": "<ISSUE-KEY>", "title": "...", "epic": "billing",
            "story": "As a <user>, ...", "acceptance_criteria": ["..."],
            "skill": "frontend|backend|fullstack"}]}
```

2. The epics grill must be recorded AGAINST THIS FILE
   (`record_grill_from_json.py --gate epics --input-digest /tmp/roadmap.json`)
   and the PM must approve BEFORE the import — relay:
   `./forge decision new epics-approved` (list the epics), then THE PM runs
   `./forge decision accept epics-approved --by "<PM>"`.
3. Then record: `./forge roadmap import --input /tmp/roadmap.json` — the
   import verifies the grill digest matches this exact file.

`plans/roadmap.json` survives every task cycle (intake marks items active,
pr_ready marks them done, the EM assigns with `forge roadmap assign`,
`forge next` suggests the next pending one); refine it by PR as planning
learns more. Per-task decompositions never rewrite the roadmap — but the
per-task PLAN must satisfy the roadmap item's `acceptance_criteria` when
present, not re-derive them.

Each task should include:
- `id`
- `title`
- `epic_id`
- `objective`
- `write_scope`
- `dependencies`
- `acceptance_criteria`
- `verify_commands`
- `required_tests`
- `reviewer_focus`
- `linear_parent`
