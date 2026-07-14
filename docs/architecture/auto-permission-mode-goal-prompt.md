# Goal: Auto-Permission Mode (LLM classifier for gray-zone tool calls)

**Status: SUPERSEDED (2026-07-13).** The attended/requester-trust verdict model
described here was replaced by the action-based model with a deterministic
read-only gate — see `docs/architecture/auto-permission-action-based-goal-prompt.md`
and the "Auto-permission mode" section of
`docs/architecture/capability-management.md`. Historical record below.

## Objective

Add a per-agent `permission_mode: ask | auto` that consults an in-process LLM
classifier when a gray-zone tool call is about to interrupt a human with a
permission prompt. The classifier may only choose `allow` or `ask` — never
deny. Every verdict is audited as a runtime event; repeated auto-allows of the
same rule shape trigger a one-tap "make this permanent?" prompt that lands in
the existing durable tool-rule machinery. Coverage includes unattended
(zero-timeout) jobs: gray-zone calls that today insta-deny become
allow-or-deny-with-reason.

## Locked decisions (do not re-litigate)

1. **Verdict space is `allow | ask` only.** Hard deny stays deterministic:
   neutral pre-checks (protected capability, memory boundary, yolo denylist,
   `tool_rules`) and the locked access preset are unchanged and always run
   first. The classifier is consulted only when today's flow would render a
   human prompt (or insta-deny unattended).
2. **v1 gray zone = third-party MCP tools + shell (`Bash`/`RunCommand`) only.**
   Spend, credentials, settings mutations, outward-facing sends, agent
   delegation, and all admin/review/promotion prompts are excluded by request
   family — the classifier is never invoked for them. Eligibility is a
   deterministic function, unit-tested at its boundaries.
3. **Config**: per-agent `permission_mode: 'ask' | 'auto'` (default `ask`) in
   `settings.yaml`, plus a per-conversation override command following the
   `/thinking` pattern (show/set/default; state on `AgentConfig` of the
   conversation route). Optional global `permissions.auto_mode.model`; default
   = the memory extractor slot model.
4. **Classifier invocation**: `getMemoryLlmClient().query()` (the established
   library-level utility seam used by memory extraction/dreaming/brain). NOT a
   registered agent, NOT the inline-lane dispatcher. Strict JSON verdict
   `{decision: 'allow'|'ask', reason: string}` — hand-parsed and
   Zod-validated. Timeout ~3s. Fail to `ask` on timeout, parse failure, or
   unconfigured LLM port — with a warn log + telemetry. Worst case is exactly
   today's behavior.
5. **Auto-allow resolution**: mode `allow_once`, classification
   `user_temporary`, `decidedBy: 'auto_classifier'`. The decision
   classification union is NOT extended (runner response parsers stay
   untouched). Audit distinction = `decidedBy` + the runtime event.
6. **Audit**: new runtime event type `permission.classifier_decision` emitted
   for EVERY verdict (allow and ask), payload: toolName, canonical rule
   suggestion key (when derivable), decision, reason, latencyMs, agentId,
   runId/jobId. Events are audit output only — never the promotion authority.
7. **Promotion flywheel**: a purpose-built counter table (agent folder +
   suggestion key → count, last_offered_at) incremented on classifier
   auto-allows that carry a synthesizable suggestion. At count 3 (constant),
   emit a one-tap durable prompt (`decisionOptions:
   ['allow_persistent_rule','cancel']`) carrying the pre-validated
   suggestions; a tap persists via the existing
   `PermissionManagementService.applyPersistentToolRuleGrant` path (template
   caller: `apps/core/src/jobs/request-permission-review.ts`). Offer at most
   once per key (last_offered_at set ⇒ never re-offer in v1).
8. **Permission choices stay bounded.** This plan introduces no permission
   decision modes. Prompts offer `allow_once`, `allow_persistent_rule` when a
   persistent suggestion exists, and `cancel`. No memory input to the classifier
   in v1. Weekly digest is v2.

## Architecture contract (validated against code)

- **Three host-side consult sites, one shared helper** (new module in
  `apps/core/src/application/permissions/`, e.g. permission-classifier.ts):
  1. `apps/core/src/runtime/core-tools/registry.ts` — after
     `evaluateNeutralToolPolicy` non-allow, before the
     `runDurablePermissionInteraction` prompt.
  2. `apps/core/src/runtime/ipc-interaction-processing.ts`
     (`processPermissionInteractionIpc`) — worker-lane asks arriving via
     signed IPC request files, before the channel prompt renders. On `allow`,
     resolve immediately (write the IPC response) instead of prompting.
  3. `apps/core/src/app/bootstrap/inline-agent-loop-tools.ts` — the inline
     third-party MCP authorizer's ask path.
- **Unattended path (runner-side bounded wait)**: today
  `apps/core/src/runner/permission-ipc-client.ts` and
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/permission-callback.ts`
  write the request file then immediately deny when the permission timeout is
  <= 0. New behavior: when the runner env carries the auto-mode flag, those
  zero-timeout paths instead poll for the host response for a bounded
  classifier window (constant, ~15s). Host consults the classifier for
  eligible families: `allow` ⇒ allow_once response; `ask` ⇒ deny response
  written immediately (no human available). Non-eligible families keep the
  immediate deny. The flag rides the existing runner-env projection
  (agent-spawn), NOT a new IPC channel.
- **No recursion**: the promotion prompt and any non-tool permission request
  (request_permission review, admin) are excluded by family filter inside the
  shared helper.
- **Suggestion synthesis**: shared host-side function producing
  `PermissionApprovalUpdate[]` only for rule shapes the durable-access policy
  already accepts — scoped `RunCommand(...)` shell rules reusing the Claude
  worker gate's derivation. Third-party MCP tools synthesize NOTHING in v1
  (closeout correction 2026-07-12): the Agent Access design routes durable
  third-party access through reviewed semantic capabilities
  (`request_access target.kind=capability`), never raw `mcp__` tool rules, so
  MCP calls get per-call classifier relief but no promotion offer. All
  synthesized rules pass the existing `validatePersistentRule` path before
  being attached or counted; the durable-access policy itself is NEVER
  loosened for this feature.
- **New event type**: one line in
  `apps/core/src/domain/events/runtime-event-types.ts` + explicit mapping in
  `apps/core/src/control/server/run-event-projection.ts` (permission events
  are hand-mapped there); OpenAPI event enums derive automatically.
- **Settings surface for the per-agent key** (full list — all must change
  together): hand parser
  `apps/core/src/config/settings/runtime-settings-agents-parser.ts` (whitelist
  + assignment), Zod contract `packages/contracts/src/settings/index.ts`
  (`RuntimeSettingsConfiguredAgentSchema`, strict), type
  `apps/core/src/config/settings/runtime-settings-types.ts`
  (`RuntimeConfiguredAgent`), YAML renderer
  `apps/core/src/config/settings/runtime-settings-renderer.ts`, import/export
  `apps/core/src/config/settings/settings-import-service.ts` (+ reader version
  bump), `apps/core/src/config/settings/desired-state-current-export.ts`,
  public projection `apps/core/src/config/index.ts`, spawn threading
  `apps/core/src/runtime/agent-spawn-types.ts` /
  `apps/core/src/runtime/agent-spawn-host.ts`.

## Stages

### Stage A — settings + mode plumbing
Packets:
1. Per-agent `permission_mode` across the full settings surface listed above,
   with parser/contract/renderer/import-export tests mirroring how
   `agent_harness` or `effort` were added. Reader version bump.
2. Conversation override command (parse + handler + route-config persistence),
   copying the `/thinking` command shape end to end
   (`apps/core/src/session/session-command-parse.ts`,
   `apps/core/src/session/session-commands.ts`,
   `apps/core/src/runtime/group-registry.ts`); `permissionMode` added to
   `AgentConfig` (`apps/core/src/domain/types.ts`).
3. Effective-mode resolution (conversation override > agent setting > 'ask')
   threaded into: host gate context used by the three consult sites, and the
   runner env projection for the unattended bounded wait.

### Stage B — classifier core
Packets:
1. New application-layer module: eligibility function (families + exclusions),
   verdict client on the memory-LLM port (prompt build with redaction, 3s
   timeout, strict parse + Zod, fail-to-ask incl. unconfigured port), types.
2. `PERMISSION_CLASSIFIER_DECISION` event type + projection mapping + publish
   helper.

### Stage C — consult wiring
Packets:
1. Host seams: shared consult called at the three sites; `allow` ⇒
   auto-resolve as allow_once/`decidedBy:'auto_classifier'` (registry + inline
   authorizer return allow; IPC processor writes the response file and
   resolves the durable record without rendering a prompt); `ask` ⇒ existing
   flow unchanged.
2. Runner bounded wait: zero-timeout branch in both permission clients waits
   the classifier window when the auto-mode env flag is set; host answers
   every unattended eligible request (allow or deny) within the window.

### Stage D — promotion flywheel
Packets:
1. Suggestion synthesis module + adoption at the ask/consult seams that lack
   suggestions today.
2. Counter table migration + repository method (increment-and-get, mark
   offered) + wiring: increment on audited auto-allows with a suggestion key;
   at threshold emit the one-tap durable prompt; tap → existing
   `applyPersistentToolRuleGrant`.

### Stage E — docs (orchestrator-owned, not codex)
`docs/architecture/capability-management.md`, settings reference, SDK/docs
note. Written by the orchestrator after D lands.

## Surface Impact Matrix
(settings parser/contract/renderer/import-export; session commands; runtime
core-tools registry; IPC interaction processing; inline agent loop tools;
runner permission clients ×2; deepagents gate wrappers (suggestions only);
domain events + projection; postgres schema/migration + repository; docs)

## Verification
- Unit: eligibility boundaries (hard tier + excluded families never consulted;
  promotion prompt never classified), verdict parse/fail-to-ask matrix
  (timeout, garbage JSON, unconfigured port), suggestion synthesis validity
  (all outputs pass validatePersistentRule), counter threshold + single-offer.
- Integration (mock LLM client injected via the port): consult at each of the
  three seams; unattended path allow + deny; ask-verdict parity with today's
  flow; promotion prompt emission at N=3 and persistence on tap.
- `npm run typecheck`, focused vitest, PG-gated integration suites,
  architecture gates, `npx npm@latest ci --dry-run` if lockfile touched.
- Runtime smoke: build + kickstart; flip one agent to `auto`; from Slack
  trigger a gray-zone MCP call → observe auto-allow + `permission.classifier_decision`
  event; repeat 3× → observe the one-tap promotion prompt; tap → rule in
  settings.yaml + subsequent calls silent. Knacklabs lead-gen job still green.

## Repo gate notes (for every handoff)
- Import from source modules in tests (no re-export barrels for mocked
  modules); update EVERY vi.mock site (unit/integration/e2e) when adding
  module exports; contains-not-last assertions; no provider-name literals
  outside adapter dirs; file-size budgets (check .codex/architecture-map.json).
- Orchestrator runs all PG-gated tests and npm installs; codex runs focused
  unit tests + typecheck only.
- No commits, no autoreview, no background processes from codex.

## Stage F — decision-signal criteria (added 2026-07-12 after live smoke)

Locked decisions on how human decisions and auto mode interact:

1. **Human allow-once feeds the flywheel.** Interactive `allow_once` decisions
   increment the same promotion counter as classifier auto-allows (when a
   suggestion key is synthesizable). In ask mode, reaching the threshold adds
   a hint line to the permission prompt itself ("allowed N times — Allow for
   future makes this permanent") instead of a separate offer; the button is
   already on the prompt. Offers as separate one-tap prompts remain
   auto-mode-only.
2. **Human deny is contrary evidence.** A `cancel`/reject decision resets the
   shape's counter and stamps `denied_at`; recently-denied shapes are never
   offered and the classifier prompt carries "the operator recently denied
   this tool shape" context so verdicts lean ask.
3. **Auto latitude is approver-scoped.** The classifier is only consulted when
   the triggering context is trusted: unattended scheduled runs, DMs, or a
   group sender who is a conversation control approver. Other senders always
   get today's ask behavior regardless of mode.
4. Invariant restated: mode changes never mutate durable policy; only human
   taps write rules. Counters persist across mode flips; offers fire only in
   auto mode and interactive contexts.

## Closeout addendum (2026-07-12)

Live smoke exposed four residual defects (attended verdicts anchored by the
capability list, free-text verdict fragility, audit gaps, unverified
promotion-hint rendering). Their fix contract — including the locked decision
that attended verdicts never see the capability list while unattended keeps
the strict gate — lives in
`docs/architecture/auto-permission-classifier-closeout-goal-prompt.md`, which
supersedes this document on those points.
