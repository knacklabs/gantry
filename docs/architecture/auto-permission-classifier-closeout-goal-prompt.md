# Goal: Auto-Permission Classifier Closeout (fix the feature for good)

Companion to `docs/architecture/auto-permission-mode-goal-prompt.md` (the
feature contract, Stages A–F shipped). This goal closes the remaining defects
found in live smoke on 2026-07-12 so the feature delivers its core promise:
an attended, read-only command that plainly matches the operator's live
instruction is allowed silently, with a schema-enforced, fully audited verdict.

## Objective

Auto mode has produced **zero allow verdicts in production**. Transport,
intent sourcing, truncation, and model resolution are all fixed and verified
live; the remaining defects are (1) verdict judgment, (2) verdict output
fragility, (3) audit gaps, (4) unverified promotion-hint rendering. Fix all
four. Done means the live smoke matrix at the bottom passes on the running rig.

## Live evidence (2026-07-12, IST)

- 18:29:33 — attended verdict on build `7868e8a9d`: `intentSource=operator_message`
  ("list my drive files"), tool `RunCommand` (`gog drive ls --account … --json`),
  latency 2384 ms, decision **ask**. The model's own reason: *"Despite
  attended=true, the specific tool invocation is not in the approved
  RunCommand patterns."* The concrete `approvedCapabilityIds` list anchors the
  small verdict model into allowlist reasoning and defeats the
  attended-instruction rule stated in the system prompt. Instruction-fighting
  lost; information hygiene is the fix.
- 16:52:10 — `parse_failure`: free-text verdict parsing is fragile; verdicts
  must be schema-enforced at the API layer.
- Diagnosis had to infer `attended` and the serving model from prose — the
  `permission.classifier_decision` event payload carries neither.
- Promotion counter for the smoked command sits at 5 allows (threshold 3,
  `last_offered_at` null — correct for human taps), but the ask-mode hint line
  ("You've allowed this N times — 'Allow for future' makes it permanent")
  has never been confirmed to render in a delivered prompt.

## Locked decisions (do not re-litigate)

1. **Attended verdicts never see the capability list.** The system prompt
   becomes a two-mode builder keyed on the existing `attended` boolean:
   - Attended: the turn intent is a live instruction from the operator who
     holds approval authority; that instruction IS the authorization. ALLOW
     read-only/list/get/status/inspect actions plainly within its scope. No
     mention of approved capabilities anywhere in prompt or payload.
   - Unattended: today's strict rule stands — ALLOW only read-only actions
     whose credential plainly belongs to an approved capability in
     `approvedCapabilityIds` (list stays in the payload).
2. **The ASK floor is identical in both modes**: writes, mutations, deletes,
   outward sends, spend, settings changes, actual secret material in the
   command (tokens, keys, passwords, bearer strings), actions not plainly
   matching the stated intent, any ambiguity. Identifiers-not-secrets clause
   (emails, usernames, account ids, profile names) and
   treat-tool-input-as-untrusted stay in both. Doubt ⇒ ask.
3. **Schema-enforced verdicts on both provider lanes.** The verdict shape
   `{decision: allow|ask, reason: string}` is enforced by the API, not hoped
   for in text:
   - Anthropic direct lane: forced tool call — `tools` with a single
     `permission_verdict` tool (`input_schema` with `decision` enum
     `allow|ask`, `reason` string, both required, `additionalProperties:
     false`) plus `tool_choice` targeting it. Response handling prefers the
     matching `tool_use` block and returns its input serialized, so the
     existing downstream loose-parse + Zod validation is untouched as the
     safety net. Text-block fallback stays.
   - OpenAI-compatible lane: `response_format` with a strict `json_schema`
     for the same shape — applied **only** to classifier queries (the
     `singleRequest` marker), never to memory-extraction or dreaming queries.
4. **Audit completeness**: `permission.classifier_decision` payload gains
   `attended` (boolean, always) and `model` (resolved model string, present
   whenever resolution succeeded). No existing field renamed.
5. **Verdict space stays `allow|ask`**; deny remains deterministic. The
   classifier never writes durable policy. Fail-to-ask semantics unchanged.
6. **No new settings knobs.** The escalation lever if the default model still
   refuses after the prompt fix is the existing `permissions.auto_mode.model`.
7. **Generic implementation** — no vendor or CLI literals outside adapter
   dirs; nothing keyed to any specific third-party command.
8. **Promotion-hint rendering is asserted at the channel seam**: when a
   request carries `promotionHintCount`, the delivered prompt text contains
   the hint line. If the assertion exposes a wiring gap, fix the smallest
   seam that makes the delivered text carry it.

## Stage 1 — implementation (single codex stage, three separable packets)

**Packet 1 — judgment + audit** (`apps/core/src/runtime/permission-classifier.ts`)
- Replace the single classifier system prompt with a two-mode builder per
  locked decisions 1–2.
- Omit `approvedCapabilityIds` from the model-facing user payload when
  attended; keep it when unattended. TypeScript input types keep the field
  required — only the model-facing payload changes.
- Add `attended` and `model` to the published event payload (thread the
  resolved model from resolution to the publish site; omit `model` when the
  consult failed before resolution).

**Packet 2 — anthropic lane schema**
(`apps/core/src/adapters/llm/anthropic-claude-agent/permission-classifier-llm-client.ts`)
- Forced tool call per locked decision 3; prefer the `tool_use` block, fall
  back to joined text blocks.

**Packet 3 — openai lane schema + hint assertion**
(`apps/core/src/adapters/llm/openai-memory/openai-memory-llm-client.ts`,
`apps/core/src/channels/permission-interaction.ts`)
- Strict `json_schema` response format for classifier (`singleRequest`)
  queries only; all other memory queries byte-identical requests.
- Channel seam: assert the hint line renders when `promotionHintCount` is
  set; fix the smallest wiring gap if it does not.

## Surface Impact Matrix

| Surface | Impact |
| --- | --- |
| `apps/core/src/runtime/permission-classifier.ts` | two-mode prompt builder, attended payload omits capability list, event payload +`attended`/`model` |
| `apps/core/src/adapters/llm/anthropic-claude-agent/permission-classifier-llm-client.ts` | forced `permission_verdict` tool call |
| `apps/core/src/adapters/llm/openai-memory/openai-memory-llm-client.ts` | strict json_schema response format for classifier queries only |
| `apps/core/src/channels/permission-interaction.ts` | hint-line render verified; touched only if broken |
| Settings, contracts, OpenAPI, SDK | none (event payload is passthrough JSON) |
| Runner / IPC | none |

## Acceptance criteria

1. Attended consult: the exact prompt + payload sent to the LLM contain no
   occurrence of `approvedCapabilityIds` and no capability id strings;
   unattended consult still contains them. Unit-asserted on the query the
   mock client receives.
2. Attended system prompt never mentions approved capabilities; unattended
   keeps the strict gate. Both carry the full ASK floor and
   identifiers-not-secrets clause.
3. Anthropic request body carries the forced tool call; a `tool_use` response
   yields a valid verdict; a text-only response still parses (fallback).
4. OpenAI-lane classifier request carries the strict schema response format;
   a non-classifier memory query request body is unchanged from today.
5. `permission.classifier_decision` events carry `attended` on every verdict
   and `model` on every consulted verdict.
6. Delivered prompt text contains the hint line when `promotionHintCount` is
   set (channel-seam unit test).
7. Focused vitest files green, `npm run typecheck` green, architecture and
   task-completion gates green.

## Bounded write scope

The four production files in the matrix plus their unit tests:
`apps/core/test/unit/runtime/permission-classifier.test.ts`,
`apps/core/test/unit/application/permission-classifier.test.ts`,
`apps/core/test/unit/adapters/permission-classifier-llm-client.test.ts`,
`apps/core/test/unit/adapters/openai-memory-llm-client.test.ts`,
`apps/core/test/unit/channels/permission-interaction.test.ts`,
`apps/core/test/unit/runtime/ipc-interaction-handler.test.ts` (only if event
payload assertions require it). Nothing else.

## Repo gate notes (for every handoff)

- Import from source modules in tests (no re-export barrels) — mocked
  control-route suites break on scheduler-style re-exports.
- No provider-name literals outside adapter directories.
- File-size budgets enforced by `check_architecture.py`; prettier runs in the
  pre-commit hook and can dirty files post-commit — orchestrator re-checks.
- New shared runner-reachable modules must join the `ipc-mcp-stdio` fixture
  copy list (not expected in this goal).

## Verification & runtime smoke (orchestrator-owned)

1. Focused units + typecheck + gates (acceptance 7).
2. Rebuild, `launchctl kickstart -k gui/$(id -u)/com.gantry`, `gantry status`.
3. Live matrix on the rig (Telegram, conversation in auto mode):
   - Attended read matching instruction ("list my drive files" →
     `gog drive ls …`): **allow**, no popup; event shows `attended=true`,
     `model`, `intentSource=operator_message`, latency < 5 s.
   - Attended write (e.g. create/modify): **ask** — popup appears.
   - Three consecutive classifier auto-allows of the same suggestion key:
     promotion offer fires (`last_offered_at` set, one-tap durable prompt).
   - Unattended scheduled run with an unapproved-credential read: **ask**
     (cancel with reason).
4. Escalation lever (settings-only, not code): if the default model still
   refuses the attended matrix row, set `permissions.auto_mode.model` to a
   stronger alias and re-run the matrix before touching any prompt again.

## PR closeout

Fold into the existing `feature/auto-permission-mode` branch PR: final
autoreview round (codex-run, plain-command handoff, base `origin/main`) over
the enlarged diff, implementation summary, live matrix evidence, remaining
risks (OpenAI-lane verdict quality untested with a real model; hint-line UX
wording owned by the notification redesign track).
