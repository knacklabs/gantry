# Boondi Domain Skills Migration Plan

Status: Draft plan, read-only code review complete. No implementation started.

Updated: 2026-06-20.

Template alignment: reviewed against
`agents/boondi_support/docs/plan-guiding-template.md`.

Testing level decision: not approved yet. This plan proposes minimal focused
live proof first. Full live regression must be approved by the user before it is
planned or run.

## Goal

- In scope: replace the selected monolithic runtime skill `boondi-kb` with
  multiple Boondi-owned, progressive, domain-specific SDK skills.
- Out of scope: rewriting Gantry skill materialization architecture,
  broadening MCP behavior, changing Boondi tone policy, or running full live
  Template_BA regression without explicit user approval.
- Success means: live payloads expose the domain skills, the always-on prompt
  stays free of full skill bodies, relevant live replies remain correct, and
  `boondi-kb` is no longer selected.
- Non-goals: exact LLM wording matches, hard-coding Boondi skill names into
  Gantry core, or maintaining two runtime sources of truth.

## Current Evidence

Code evidence:

- Agent-folder SDK skills must live as folders with `SKILL.md`:
  `agents/boondi_support/skills/<skill-id>/SKILL.md`.
- Flat files like `agents/boondi_support/skills/boondi-gifting.md` are ignored.
- Folder presence alone does nothing. The skill id must be declared under
  `agents.<folder>.plugins.skills`.
- `plugins.skills` already accepts multiple folder ids.
- `SKILL.md` frontmatter `name:` must match the folder id after sanitization, or
  materialization fails.
- The materializer copies only valid skill folders into the per-run Claude SDK
  `skills/` directory.
- The runner passes materialized names through SDK `options.skills`.
- When SDK skills are enabled and native tool surface is restricted, Gantry adds
  the provider-native `Skill` tool.
- Progressive agent-folder skill pointers are generated without inlining the
  skill body into `systemPrompt.append`.

Existing runtime/live evidence:

Live payloads currently expose:

```json
"skills": ["boondi-kb", "gantry-admin"]
```

The individual files under `agents/boondi_support/kb/` are not independently
loaded as skills. They are source Markdown files only. The runtime skill is
`agents/boondi_support/skills/boondi-kb/SKILL.md`, which repeats domain details
because it is the only Boondi business skill selected today.

This is not the robust long-term architecture.

Primary code paths:

- `apps/core/src/adapters/llm/anthropic-claude-agent/claude-skill-materializer.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/claude-config-materializer.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/execution-adapter.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/native-sdk-skills.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`
- `apps/core/src/config/settings/runtime-settings-agents-parser.ts`
- `apps/core/src/config/settings/runtime-settings-renderer.ts`
- `apps/core/src/runtime/session-resume-runtime.ts`

Existing payload/log/trace evidence:

- `llm-sdk-query-args.json` has shown `skills:["boondi-kb","gantry-admin"]`.
- Previous focused live checks showed `boondi-kb` can be progressively listed,
  but did not prove individual domain skill selection because those skills do
  not yet exist as selected runtime skills.

Existing transcript/output evidence:

- Functional Template_BA evidence existed before this migration plan, but this
  plan must not claim the split is safe until focused live proof and
  cross-regression pass after the split.

Assumptions not yet proven:

- Each domain skill body can be split without losing regression-critical
  guidance.
- The runtime desired-state update will project all selected domain skills into
  `options.skills` in the live webhook path.
- The provider-native `Skill` tool will open the expected domain skill in
  representative live turns.

Open questions:

- Whether full live Template_BA regression is required after focused proof. This
  must be decided by the user before any full live run is planned or executed.

## Source Of Truth

- Code is the source of truth for skill discovery, materialization, runtime
  selection, and SDK payload shape.
- Live signed webhook behavior is the acceptance proof for customer-facing
  behavior.
- Docs, MD files, Excel sheets, and prior notes are references, not proof.
- If docs disagree with code or observed behavior, update the docs after proof.

## Target Architecture

Runtime-facing Boondi knowledge lives in skill folders:

```text
agents/boondi_support/skills/
  boondi-gifting/
    SKILL.md
  boondi-product-care/
    SKILL.md
  boondi-orders/
    SKILL.md
  boondi-store-aggregator/
    SKILL.md
  boondi-misc-policy/
    SKILL.md
```

The active runtime config selects these folder skills:

```yaml
agents:
  boondi_support:
    plugins:
      skills:
        - boondi-gifting
        - boondi-product-care
        - boondi-orders
        - boondi-store-aggregator
        - boondi-misc-policy
```

Expected live SDK payload after migration:

```json
"skills": [
  "boondi-gifting",
  "boondi-product-care",
  "boondi-orders",
  "boondi-store-aggregator",
  "boondi-misc-policy"
]
```

Other unrelated selected runtime/admin skills may also appear, such as
`gantry-admin`, but the Boondi business skill set must be the five domain skills
above.

`boondi-kb` must not remain selected after cutover.

## Ownership Boundary

- Runtime/framework owns: generic skill discovery, materialization, selected
  skill projection, SDK payload construction, and provider-native `Skill` tool
  wiring.
- Product/domain/agent owns: Boondi domain skill content, selected Boondi skill
  ids, customer-facing behavior expectations, and evidence docs.
- Prompt files own: compact universal routing, safety, and customer experience
  rules only.
- Skill/KB files own: progressively loaded domain playbooks that are useful to
  the LLM at answer time.
- MCP/tool contracts own: source-backed live facts and compact tool outputs.
- Config owns: selected Boondi skill ids through `agents.boondi_support.plugins.skills`.
- Docs own: human mapping, migration status, Template_BA traceability, and
  evidence.
- Must not be duplicated: runtime domain knowledge must not live in both
  `kb/*.md` and `skills/*/SKILL.md` as active sources.

Detailed rules:

- Gantry core remains generic. Do not hard-code Boondi skill names in core.
- Boondi domain knowledge stays under `agents/boondi_support/skills/`.
- Runtime skill bodies contain only LLM-useful playbooks.
- Human mapping, Template_BA traceability, phase status, and evidence stay under
  `agents/boondi_support/docs/`.
- MCPs remain the source for live product, stock, order, price, discount,
  serviceability, and delivery facts.
- `CLAUDE.md` remains compact universal routing/safety guidance, not a domain KB.
- Do not point runtime skills to sibling `../kb/*.md` unless materialization is
  changed to copy those assets. Today only the skill folder is copied.
- Use `plugins.skills` for these Boondi-owned agent-folder skills. Do not use
  `sources.skills` unless the skills are intentionally installed through the
  catalog/artifact store. Current target is agent-folder ownership.
- If `agents/boondi_support/kb/*.md` remains after migration, it must be clearly
  human-only source material. It must not contain runtime/progressive
  frontmatter that makes it look like an active skill.

## Testing Strategy

- Static/code checks first: settings parse/render, skill materialization, SDK
  option projection, progressive pointer context, and restricted native `Skill`
  tool availability.
- Unit/integration checks next: focused tests listed in Phase 2.
- Minimal focused live/runtime tests next: 3-5 signed webhook scenarios that
  prove domain skill selection, progressive loading, reply safety, and no
  `boondi-kb` payload.
- Cross-scenario regression next: the focused pack in Phase 5.
- Payload/log/trace checks: inspect `llm-sdk-query-args.json`, trace payloads,
  and Skill tool openings for each live proof row.
- Output/reply checks: inspect customer-visible replies for correctness,
  warmth-sensitive regressions, unsupported promises, and leakage.
- Full live Template_BA regression: not approved yet. Ask the user whether the
  plan needs full live testing or minimal focused live testing before planning
  or running any full live regression.

## Migration Phases

Default phase statuses are `Pending`, `In progress`, `Blocked`, and `Done`.
Do not move to the next phase until evidence is recorded and the reviewer
decision is updated.

### Phase 0: Freeze Current Evidence

- Status: Pending.
- Objective: preserve the current monolithic proof before removing
  `boondi-kb`.
- Changes allowed: evidence capture only; no code, prompt, config, or live
  runtime behavior changes.
- Evidence required:
  - Record current live payload shape: `skills:["boondi-kb","gantry-admin"]`.
  - Record current `boondi-kb/SKILL.md` word count and selected skill body risk.
  - Record latest passing Template_BA evidence bundle paths from the
    architecture evidence doc.
  - Confirm all local runtime servers are stopped before editing.
  - Add the evidence entry to this plan or the main Boondi evidence plan.
- Regression risk: none from this phase because it is read-only evidence
  capture.
- Reviewer decision: Pending.

### Phase 1: Create Real Domain Skill Folders

- Status: Pending.
- Objective: convert each runtime-facing KB into a real SDK skill package.
- Changes allowed:
  - Create `agents/boondi_support/skills/boondi-gifting/SKILL.md`.
  - Create `agents/boondi_support/skills/boondi-product-care/SKILL.md`.
  - Create `agents/boondi_support/skills/boondi-orders/SKILL.md`.
  - Create `agents/boondi_support/skills/boondi-store-aggregator/SKILL.md`.
  - Create `agents/boondi_support/skills/boondi-misc-policy/SKILL.md`.
- Evidence required:
  - Each new skill folder has a valid `SKILL.md`.
  - Each `SKILL.md` frontmatter `name:` exactly matches its folder id.
  - Each `description:` is trigger-focused and compact.
  - Each `SKILL.md` has `disclosure: progressive`.
  - Word counts are recorded for every skill.
  - `rg` confirms no `Status:`, `Scope:`, `Source Scenarios`, or Template_BA
    table rows inside runtime skill bodies.
- Regression risk: content migration can drop operational guidance or warmth
  semantics even if payload wiring is correct.
- Reviewer decision: Pending.

Content source rules:

- Use the current cleaned `agents/boondi_support/kb/*.md` bodies as input.
- Do not blindly copy if any body still contains human-only metadata.
- Body must contain only runtime decision guidance.
- Do not include live facts that belong to MCPs.
- Treat `agents/boondi_support/kb/` as a temporary migration source only. After
  live proof, delete it or move it under docs as human-only source mapping.

### Phase 2: Add Regression Tests For Skill Split

- Status: Pending.
- Objective: prove the architecture cannot silently fall back to one monolithic
  skill or lose progressive behavior.
- Changes allowed: focused unit/regression tests for settings parsing,
  materialization, progressive context, native Skill tool availability, and
  runner SDK options.
- Evidence required:
  - `apps/core/test/unit/config/agent-plugins-settings.test.ts` parses/renders
    multiple `plugins.skills` ids, including Boondi-style ids.
  - `apps/core/test/unit/adapters/claude-config-materializer.test.ts`
    materializes multiple declared agent-folder skills and proves an undeclared
    `boondi-kb` folder is inert.
  - `apps/core/test/unit/runtime/session-resume-runtime.test.ts` proves
    multiple progressive pointers are present and skill bodies are not injected.
  - `apps/core/test/unit/runner/native-sdk-skills.test.ts` proves restricted
    native surface still exposes `Skill` when multiple SDK skills are enabled.
  - `apps/core/test/unit/runner/agent-runner-ipc.test.ts` proves the runner
    receives all domain skills in `options.skills`.
  - Focused unit test command passes.
  - `npm run typecheck` passes.
- Regression risk: test expectations may accidentally encode Boondi behavior in
  Gantry core. Keep Boondi ids as fixtures only; no production hard-coding.
- Reviewer decision: Pending.

### Phase 3: Deactivate Monolith And Select Domain Skills

- Status: Pending.
- Objective: make the runtime expose domain skills instead of `boondi-kb`.
- Changes allowed:
  - Replace `agents.boondi_support.plugins.skills: [boondi-kb]` with the five
    domain skill ids.
  - Apply the same desired-state update in the repo/runtime source used for live
    tests, including `/Users/caw-d/gantry/settings.yaml` when testing locally.
  - Leave the `boondi-kb` folder on disk only during the first cutover test, but
    do not select it.
- Evidence required:
  - Settings parse/render still passes after the desired-state update.
  - Local materialization test confirms `boondi-kb` is inert when undeclared.
  - No live success claim is made in this phase; live proof is Phase 4.
- Regression risk: wrong active settings source can make static proof pass while
  live runtime still selects `boondi-kb`.
- Reviewer decision: Pending.

### Phase 4: Live Payload Proof

- Status: Pending.
- Objective: prove the live runtime payload is modular and progressive.
- Changes allowed: minimal focused signed webhook tests only; not the full
  Template_BA pack unless the user separately approves full live testing.
- Evidence required:
  - Run 3-5 signed webhook scenarios:
    `pre-06-gift-budget`, `pre-04-allergen-jain`, `del-01-order-status`,
    `cafe-02-nearest-store` or `agg-04-bill`, and `misc-03-franchise` or
    `misc-02-repeat-opt-out`.
  - `llm-sdk-query-args.json` is a latest-only object, not an appended array.
  - `options.skills` includes all selected domain skills.
  - Other unrelated runtime/admin skills may appear, such as `gantry-admin`,
    but are not part of Boondi business skill acceptance.
  - `options.skills` does not include `boondi-kb`.
  - Prompt includes progressive skill pointers.
  - Prompt does not contain full domain skill bodies.
  - For at least three representative domains, persisted trace payloads or SDK
    debug evidence show provider-native `Skill` opened the expected domain
    skill id, not `boondi-kb`.
  - Evidence files are stored under `/tmp/...` or a documented evidence
    directory.
- Regression risk: payload shape can be correct while reply quality regresses,
  so Phase 5 must still run.
- Reviewer decision: Pending.

### Phase 5: Focused Cross-Regression

- Status: Pending.
- Objective: prove splitting skills did not break nearby scenarios.
- Changes allowed: focused cross-regression only; no broad prompt or MCP edits
  unless this phase finds a specific defect and reviewer approves a fix batch.
- Evidence required:
  - Run `pre-03-custom-pack-size`, `pre-05-missed-window`,
    `pre-08-gst-logo`, `del-01-order-status`, `post-02-card-missing`,
    `cafe-02-nearest-store`, `misc-02-repeat-opt-out`, and `agg-04-bill`.
  - Strict reviewer passes focused pack.
  - Human review confirms tone/semantics are not worse for known
    warmth-sensitive replies.
  - Payload proof still shows modular skills and no `boondi-kb`.
- Regression risk: a fix for one domain skill can shift another domain's
  behavior. Fix only classified defects, then rerun the affected focused pack.
- Reviewer decision: Pending.

### Phase 6: Remove Or Retire `boondi-kb`

- Status: Pending.
- Objective: eliminate the workaround and avoid future accidental use.
- Changes allowed:
  - Delete `agents/boondi_support/skills/boondi-kb/` after all live checks pass.
  - Keep a deprecated runtime folder only if the reviewer explicitly asks for a
    short rollback window. If kept, it must remain unselected and have a dated
    removal note.
- Evidence required:
  - No active config selects `boondi-kb`.
  - No live payload lists `boondi-kb`.
  - Cleanup search is recorded.
  - Any remaining `boondi-kb` match is classified.
- Regression risk: stale active references can silently reselect the monolithic
  skill later.
- Reviewer decision: Pending.

Required cleanup check:

```bash
rg -n "boondi-kb|skills:\\s*\\[\"boondi-kb\"|Skill\\(boondi-kb\\)" \
  agents/boondi_support apps/core/test docs README.md
```

Any remaining match must be classified:

- historical evidence only
- migration doc only
- test fixture intentionally covering legacy behavior
- stale active reference to remove

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Boondi will expose multiple domain SDK skills instead of one monolithic skill. |
| `settings.yaml` | Changed | `agents.boondi_support.plugins.skills` must list domain skill ids and remove `boondi-kb`. |
| Postgres/runtime projection | Read-only/observable | Runtime selected skill context should reflect configured skills; no schema change expected. |
| Control API | Unchanged by design | Existing settings/skill surfaces already support multiple ids. |
| CLI | Unchanged by design | Existing settings parse/render should be enough. |
| SDK/contracts | Changed | `options.skills` should contain five domain skills; SDK API shape unchanged. |
| Gantry MCP tools/admin skill | Unchanged by design | No new admin tool required. |
| Shopify MCP | Unchanged by design | Still source of live product/order/discount facts. |
| CRM MCP | Unchanged by design | Still not used for fresh order support or live lead capture unless separately designed. |
| Channel/provider adapters | Unchanged by design | Same signed Interakt webhook proof path. |
| Docs/prompts | Changed | Update Boondi evidence docs and remove monolithic-skill guidance. |
| Audit/events | Read-only/observable | Live traces should show `Skill` usage and selected skill ids. |
| Tests/verification | Changed | Add focused unit tests and live payload/reply evidence. |

## Token, Cost, And Rate-Limit Discipline

- Reuse Phase 0 evidence before generating new live evidence.
- Do not run broad live suites after every small edit.
- Keep skill bodies compact and progressive; do not solve routing by dumping
  examples into always-on prompt context.
- Prefer deterministic static/unit checks before LLM/API calls.
- Cap live testing to the minimal focused pack until payload shape is proven.
- Ask the user before planning or running full live Template_BA regression.

## Risk Controls

- Do not reduce operational detail during the split unless a live test proves it
  is redundant.
- Do not use `kb/*.md` as runtime references from inside `SKILL.md` unless
  those files are copied into the materialized skill folder.
- Do not keep both `kb/*.md` and `skills/*/SKILL.md` as competing runtime
  sources of truth.
- Do not claim success from static tests. Live signed webhook payload and reply
  evidence is required.
- Keep live test batches small until payload shape is correct.
- Stop all local servers after live tests and verify ports are free.

## Rollback And Cleanup

- Old path removed: `agents/boondi_support/skills/boondi-kb/` after live proof,
  unless the reviewer explicitly approves one short rollback window.
- Duplicate source removed: `agents/boondi_support/kb/*.md` must be deleted or
  moved under docs as human-only source mapping after proof.
- Docs updated: this plan and any Boondi evidence docs must reflect the final
  selected-skill architecture.
- Stale references searched: run the Phase 6 cleanup search and classify every
  remaining match.
- Generated artifacts handled: evidence files may live under `/tmp/...` during
  proof, but final evidence paths must be recorded in this plan or the main
  evidence doc.
- No commit/stage unless explicitly requested.

## Architecture Decisions

1. Use `plugins.skills` for this migration because these are Boondi-owned
   agent-folder skills.
2. Prefer deleting `boondi-kb` after live proof. Keeping it as a non-selected
   folder is acceptable only for one short review window.
3. Prefer deleting `agents/boondi_support/kb/*.md` or moving them under docs
   after the split is proven. Do not keep them as a parallel runtime source.

## Verification Commands

Static and unit checks:

```bash
npm run test:unit -- \
  apps/core/test/unit/config/agent-plugins-settings.test.ts \
  apps/core/test/unit/adapters/claude-config-materializer.test.ts \
  apps/core/test/unit/runtime/session-resume-runtime.test.ts \
  apps/core/test/unit/runner/native-sdk-skills.test.ts \
  apps/core/test/unit/runner/agent-runner-ipc.test.ts

npm run typecheck

git diff --check
```

Live focused proof:

```bash
npm run dev:boondi-runtime

npx tsx agents/boondi_support/evals/run-template-ba-live.ts \
  --id pre-06-gift-budget \
  --out /tmp/boondi-domain-skills-gifting.json \
  --wait-ms 120000

npx tsx agents/boondi_support/evals/run-template-ba-live.ts \
  --id pre-04-allergen-jain \
  --out /tmp/boondi-domain-skills-product-care.json \
  --wait-ms 120000

npx tsx agents/boondi_support/evals/run-template-ba-live.ts \
  --id del-01-order-status \
  --out /tmp/boondi-domain-skills-orders.json \
  --wait-ms 120000
```

After live runs, inspect `llm-sdk-query-args.json` and stop the runtime. Verify
ports `4710`, `8081`, and `8082` are free.

## Self-Review

Findings from self-review:

- Strong: the plan is code-grounded and uses the existing materialization path
  instead of proposing a new Gantry mechanism.
- Strong: the plan avoids hard-coding Boondi behavior in Gantry core.
- Strong: the plan requires live signed webhook payload and reply evidence, not
  only static tests.
- Fixed during review: expected payload no longer treats `gantry-admin` as part
  of the Boondi business skill set.
- Fixed during review: `plugins.skills` is now an explicit architecture
  decision, not an open question.
- Fixed during review: live proof must show individual domain skills are
  actually opened through provider-native `Skill`, not merely listed.
- Fixed during second review: Phase order now adds regression tests before
  switching live desired state, and live payload proof is isolated to Phase 4.
- Fixed during second review: `gantry-admin` is consistently treated as an
  unrelated runtime/admin skill, not a Boondi business skill requirement.
- Fixed during second review: `kb/*.md` cleanup is no longer an open-ended
  decision; the default is delete or move under docs after live proof.
- Fixed during second review: exact static and live verification commands are
  documented.
- Remaining risk: the plan still depends on careful content migration. If a
  domain skill body drops regression-proven wording, behavior can regress even
  when payload shape is correct. Phase 5 cross-regression is the guard for this.
- Remaining risk: if `kb/*.md` remains with skill-like frontmatter after
  migration, humans may confuse it with runtime skills. Phase 6 must clean that
  up.

## Live Acceptance Criteria And Final Acceptance Gate

The migration is accepted only when all are true:

- Live payload lists domain skills and not `boondi-kb`.
- Progressive pointer exists for each selected domain skill.
- Full domain skill bodies are absent from always-on prompt payload.
- Relevant live replies pass strict review and human warmth/semantics review.
- Focused cross-regression passes.
- No internal/process/source leakage.
- No unsupported promises.
- No broad MCP/tool fanout.
- Evidence paths and reviewer decision are recorded.

Evidence table:

| Scenario | Runtime evidence | Payload/log evidence | Output evidence | Decision |
| --- | --- | --- | --- | --- |
| `pre-06-gift-budget` | Pending | Pending | Pending | Pending |
| `pre-04-allergen-jain` | Pending | Pending | Pending | Pending |
| `del-01-order-status` | Pending | Pending | Pending | Pending |
| `cafe-02-nearest-store` or `agg-04-bill` | Pending | Pending | Pending | Pending |
| `misc-03-franchise` or `misc-02-repeat-opt-out` | Pending | Pending | Pending | Pending |

## Final Reviewer Decision

- Approved: Pending.
- Approved with changes: Pending.
- Blocked: Pending.
- Reason: Pending live and static proof.
- Next action: reviewer must approve execution scope, including whether live
  testing remains minimal focused or expands to full live regression.
