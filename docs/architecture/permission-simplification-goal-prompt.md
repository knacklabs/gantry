# Goal Prompt: Permission Management Simplification

## Objective (user vision, 2026-07-16)

Users just use agents, install skills, and add MCP servers. Commands underneath
are managed internally (deterministic gate + classifier); ONE denylist is the
only hard boundary; prompts are plain language with no technical jargon. Reduce
the permission machinery's surface without weakening any security rail.

## Locked rails (never weakened)

Denylist backstops (command/path/egress), sanitized-input forced ask, host-side
independent judging, approver-only authority (agents/system can never
self-approve), fail-closed classifier.

## Survey findings (Explore pass, 2026-07-16)

The decision machinery is duplicated across two lanes and three enums:

- Lane A: `apps/core/src/runtime/ipc-interaction-processing.ts` +
  `apps/core/src/runtime/permission-classifier.ts` (order: eligibility → sanitized-input
  guard → YOLO denylist → deterministic read-only gate → classifier →
  unattended-cancel → promotions → prompt).
- Lane B: `apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts`
  (locked-preset denial → protected-capability guard → memory boundary →
  sandbox network gate → YOLO denylist AGAIN → tool rules → prompt).
- Three ask-how-much enums: `permission_mode` (ask/auto/auto_strict), agent
  `preset` (full/locked → internal `permissionMode: 'deny'`), per-request
  `decisionOptions`.
- Two near-identical sender lists: `control_approvers` (approve) vs
  `control_allowlist` (command).
- `decisionPolicy` enum half-wired (`control_allowlist` value is phantom).
- Durable-rule validation split across `apps/core/src/shared/durable-access-policy.ts` (the
  declared source of truth) plus three satellite re-checks.
- Jargon laundering (`USER_FACING_TOOL_LABELS`, `neutralizeImplementationTerms`,
  `humanizeIdentifier`) scattered in `apps/core/src/channels/permission-interaction.ts`.
- `permissions.auto_mode.model` is a bespoke one-key config block.

## Stages

### Stage P1 — One decision sequencer
Extract the ordered ladder (sanitized-input → denylist → deterministic/
protected gates → tool rules → promotions → prompt) into one shared module
called by BOTH lanes. Kills the duplicated YOLO backstop calls, the duplicated
"denylist hit strips persistent suggestions" logic (both lanes), and lane
drift. Large but mechanical; no config migration; no rail weakened (same rails,
called once).

### Stage P2 — One mode vocabulary
Merge `preset: locked` into `permission_mode` (value `locked`); delete
`AgentAccessPreset`. Collapse the user-facing story to two words: autonomous
(auto, the default) and supervised (ask); `auto_strict`/`locked`/`yolo` remain
operator-level values that never appear in chat copy or /permissions help.
One-line settings migration.

### Stage P3 — One authority block, one durable validator
- Fold `control_approvers` + `control_allowlist` into
  `control: { command: [...], approve: [...] }` — reshape only; approve and
  command lists stay strictly separate authorities. Settings-import shim.
- Resolve `decisionPolicy` to same-channel-only (drop the phantom enum value)
  or implement the second branch — decide during validation.
- Make `apps/core/src/shared/durable-access-policy.ts` the ONLY durable-rule shape gate;
  the three satellites call it.

### Stage P4 — One copy layer, smaller config
- Consolidate all user-facing label laundering into one `permission-copy.ts`;
  it is the only module allowed to see internal ids; audit prompt/receipt copy
  for remaining jargon (capability ids, env-var names, mode names).
- Fold `permissions.auto_mode.model` into standard model-defaults config; the
  permissions parser shrinks to `yolo_mode` + `egress` (and later one unified
  `denylist` block with kinds: commands, paths, hosts — single mental model).

## Validation findings (Codex gate, 2026-07-16 — PLAN NEEDS REVISION before P1)

- The two lanes are deliberate defense-in-depth, NOT pure duplication: the runner-side denylist check runs before rule-based auto-allows that never reach the host; the host independently rechecks. P1's sequencer must be host-owned with the runner pre-check retained; drop the "identical decisions" golden test (lanes intentionally differ on YOLO handling).
- Sanitized-input forced ask is host-owned — a runner-only or once-only sequencer could bypass it. Sequencer lives host-side.
- P2: `locked` is NOT just a mode — it strips authority/admin tool families, forces pre-provisioned installs, denies forged IPC, and must not be overridable by conversation-level mode precedence. Keep it distinct or define an un-overridable lock semantics first.
- Default-to-auto silently widens deployments omitting permission_mode (today they resolve to ask) — needs an explicit migration decision.
- P3: approver/command split maps existing users to BOTH lists initially; parser+renderer+revision canonicalization change atomically with a reader-version bump; NO compatibility shims (AGENTS.md clean-cut rule) — atomic cutover.
- P4: auto_mode.model move requires a classifier slot in the model-defaults API first; unified denylist must preserve kinds (command/path/host), yolo_mode.enabled, shipped defaults, hostname normalization, egress audit.
- Egress stays evaluated at proxy dispatch time — never a sequencer step. Durable-rule validation stays distinct from runtime rule matching (wildcard semantics differ deliberately).

## Decisions taken (user, 2026-07-16 — pre-user deployment, aggressive defaults approved)

- DEFAULT FLIPS TO AUTO: deployments omitting `permission_mode` resolve to `auto` (allow-leaning), matching the product vision; `ask` remains available per agent/conversation. The silent-widening hazard is accepted — there are no external users yet.
- `locked` stays a DISTINCT un-overridable value (technical necessity per validation: strips tool families, denies forged IPC; conversation-level mode precedence can never override it) but never appears in user-facing copy.
- Migration = atomic cutover with reader-version bump; no shims; existing docs rewritten in place. Pre-user, so no staged compatibility window.

## Process

MANDATORY Codex plan-validation pass on this doc before Stage P1 (per
AGENTS.md). Per-stage review-then-commit; assumptions ledger rows in a new
`permission-simplification-assumptions.md`. Sequenced after the July-16 audit
unless the user pulls it earlier.

## Acceptance

- Both lanes produce identical decisions for a table of representative inputs
  (golden test across the sequencer).
- Chat copy contains no capability ids, env-var names, or internal mode names.
- settings.yaml permission surface: `permission_mode`, `control{command,approve}`,
  one denylist block — nothing else user-required.
- All existing rails' tests stay green; no new gate/architecture violations.
