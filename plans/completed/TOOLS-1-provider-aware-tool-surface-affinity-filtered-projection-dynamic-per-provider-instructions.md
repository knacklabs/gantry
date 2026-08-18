---
issue: TOOLS-1
title: Provider-aware tool surface: affinity-filtered projection + dynamic per-provider instructions
status: approved
saved: 2026-08-04T17:20:42+00:00
story: TOOLS-1
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
---


# TOOLS-1 — Provider-aware tool surface: affinity-filtered projection + dynamic per-provider instructions

## Context

Every agent currently gets the same 75-tool MCP surface regardless of which chat provider its conversation lives on. The only provider-specific tools today — `canvas_read/create/update` (Slack-only) — are exposed to Telegram/Discord/Teams agents too, where they can only fail at runtime with an honest error. Worse, the *neutral* tools behave very differently per provider (Slack chunks at 4,000 chars and uploads snippets at 1 MiB; Telegram splits at 4,096 with MarkdownV2/HTML; Discord splits at 2,000 with a 4,096-byte embed budget; `ask_user_question` renders Block Kit vs inline keyboards vs ≤5 buttons) and none of that is explained to the agent. Ravi's ask: classify all tools neutral vs provider-specific, hide provider-specific ones where they can't work, and make the operating instructions dynamic — telling each agent how its tools behave on the provider it's actually on.

Discovery (two read-only Codex passes, evidence recorded in the session) established:
- **One shared projection choke point**: `selectedGantryMcpToolNames` (`apps/core/src/runner/gantry-mcp-tool-surface.ts:91`) is used by the Anthropic lane (`agent-capabilities.ts:130`), the DeepAgents lane (`gantry-mcp-env.ts`), and jobs (jobs spawn through the same `projectSpawnRunnerInput`). It receives capability options but no provider identity today — while both lanes already hold `chatJid` (and DeepAgents also `providerAccountId`).
- **Prompt assembly is already provider-conditional**: `compileSpawnSystemPrompt` (`runtime/agent-spawn-prompt.ts:21`) resolves the provider from the JID via the channel provider registry (`channels/provider-registry.ts:181`) and renders a `channelContextLine` with formatting/length guidance. `OPERATING_GUIDANCE_BLOCK` itself is provider-blind; the registry presentation is the seam.
- **Only `canvas_*` is hard provider-specific.** Everything else is neutral-with-variant-behavior.
- **This is a prompt-surface/token optimization, not a security fix**: the canvas IPC boundary already rejects non-Slack conversations fail-closed (`jobs/ipc-canvas-handlers.ts:38`), and the runner pins `chatJid` from context. The win is a cleaner tool list, fewer wasted schemas/turns, and accurate instructions.

## Approach

### 1. Tool→provider affinity, declared once

Add a declared affinity map, `apps/core/src/runner/mcp/tool-provider-affinity.ts`:

```ts
// Tools absent from this map are provider-neutral. Keys are conversation
// JID prefixes: provider-name literals are only approved under runner/mcp,
// and prefixes make the filter a plain startsWith with no registry import.
export const MCP_TOOL_PROVIDER_AFFINITY: Readonly<Record<string, readonly string[]>> = {
  canvas_read: ['sl:'],
  canvas_create: ['sl:'],
  canvas_update: ['sl:'],
};
```

Design constraints verified by the grill:
- **The map lives in `apps/core/src/runner/mcp/tool-provider-affinity.ts`, keyed by JID prefix** (`canvas_*` → `['sl:']`), not in `shared/`: `check_provider_specific_paths` approves provider literals only under `runner/mcp` (and channels/cli/adapters) — `gantry-mcp-tool-surface.ts` and `shared/` may not contain the word "slack". JID-prefix keys sidestep provider-name literals and registry imports at the filter site (plain `startsWith`). Every spawn path was enumerated: `chatJid` is always a real provider-prefixed JID (jobs/brain/observer/inline/app included), so prefix matching is total.
- **Filter in BOTH consumers of the tool-name surface.** `selectedGantryMcpToolNames` (projection; Anthropic `agent-capabilities.ts:138/:318` via required `ctx.chatJid`, DeepAgents `gantry-mcp-env.ts:64` via `GANTRY_CHAT_JID`) *and* `parseEnabledGantryMcpToolNames`/`effectiveEnabledMcpToolNames` (runner process, `runner/mcp/server.ts:84` + `context.ts:102`, keyed off `process.env.GANTRY_CHAT_JID`) — the parse path additively re-seeds from `DEFAULT_GANTRY_MCP_TOOL_NAMES`, so filtering the projection alone leaves canvas mounted and prompt-visible. One shared `applyProviderAffinity(names, chatJid)` helper in `gantry-mcp-tool-surface.ts` (data imported from the approved-path map), called from both.
- **Affinity wins over explicit operator config**: the filter runs AFTER the `GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON` loop — an explicitly configured canvas tool on a Telegram conversation still cannot function, so re-adding it would only reintroduce the dead surface. Documented in the map file.
- Unknown/absent prefix (defensive-only case — no such spawn exists today): affinity tools dropped, fail closed.
- `assertRegisteredMcpToolHandlers` verified safe: it asserts enabled ⊆ registered, and the filtered registrar skips canvas registration in lockstep.
- Jobs are not a third lane — `jobs/execution.ts:481` feeds the same spawn path; no extra wiring.

The IPC boundary check and canvas-service JID check stay as the actual security enforcement.

### 2. Dynamic per-provider tool instructions

Extend the channel provider registry's presentation contract (`channels/provider-registry.ts`) with a `toolGuidance` section per provider, rendered into the existing `channelContextLine` seam (`agent-spawn-prompt.ts:61`) — the mechanism that already injects provider formatting guidance, so this is an extension, not a new pipeline.

Guidance text is declared next to each provider's registration (`channels/register-builtins.ts`, 245 lines — ample budget headroom) and **imports the real constants** so numbers can never drift from behavior — but only from bare constant modules (`slack/text-limits.ts`, `discord-components.ts` import nothing heavy; verified no cycles). Constants currently buried in heavyweight delivery adapters (e.g. Telegram's 4,096 split in the 779-line `channel-delivery.ts`) are first lifted into small constant modules the delivery code imports back — `register-builtins.ts` is a side-effect module loaded by 14 startup paths and must not statically pull provider SDK trees. Guidance is static per run (the prompt seam is cached per-run; `chatJid` is run-stable — verified fine). Content per provider, kept to a compact block (~6-8 lines):

- how `send_message` behaves here (split threshold, what happens to oversized text, attachment cap)
- how `render_*` degrade here (Block Kit / HTML + inline keyboard / single embed / Adaptive Card; fallback to text when no rich surface)
- `ask_user_question` shape and option limits here
- which affinity tools exist here (Slack: the three canvas tools and the read→handle→edit flow) — and nothing about tools the agent doesn't have
- `attachment_open` provider notes only where they differ (Discord: ephemeral attachments unfetchable)

Neutral guidance stays where it is; nothing provider-specific remains in `OPERATING_GUIDANCE_BLOCK`.

### 3. Classification recorded

The full 75-tool classification (neutral / provider-specific / provider-variant, with evidence) lands as `docs/architecture/tool-provider-affinity.md` so the next provider (Teams live transport, WhatsApp) has a checklist: register presentation + guidance, extend affinity entries if it ships provider-specific tools.

## Files

- `apps/core/src/runner/mcp/tool-provider-affinity.ts` — NEW: affinity map (JID-prefix keys; approved provider-literal path)
- `apps/core/src/runner/gantry-mcp-tool-surface.ts` — `applyProviderAffinity` in projection AND parse paths
- `apps/core/src/runner/mcp/server.ts`, `apps/core/src/runner/mcp/context.ts` — pass `process.env.GANTRY_CHAT_JID` into the parse-side filter
- `apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts`, `apps/core/src/adapters/llm/deepagents-langchain/runner/gantry-mcp-env.ts` (or its selection call site) — pass provider
- `apps/core/src/channels/provider-registry.ts`, `apps/core/src/channels/register-builtins.ts` — toolGuidance in presentations
- `apps/core/src/runtime/agent-spawn-prompt.ts` — render guidance in the channel context block
- `docs/architecture/tool-provider-affinity.md` — classification
- Tests alongside each: unit tests for selection filtering (Slack keeps canvas, Telegram/Discord/unknown drop it; neutral tools unaffected), presentation rendering per provider, and a prompt-compile test asserting a Telegram spawn's system prompt contains Telegram guidance and no canvas mention.

## Verification

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runner apps/core/test/unit/channels apps/core/test/unit/runtime
python3 factory/scripts/verify.py
```

Behavioral checks that must exist and fail with the fix reverted:
1. Telegram/Discord spawn: `canvas_*` absent from the projected tool names; Slack spawn: present.
2. Unknown/absent provider (no conversation): affinity tools dropped (fail closed).
3. Jobs-lane spawn on a Slack conversation still projects canvas tools (same path proof).
3b. Runner-process parse path (`effectiveEnabledMcpToolNames`) also drops canvas for a Telegram `GANTRY_CHAT_JID` — the tool is unmounted, not merely un-allowlisted; and an explicitly configured canvas tool on Telegram stays dropped (affinity-wins precedence).
4. Each provider's compiled system prompt contains its own guidance constants (the literal split threshold) and no other provider's.
5. Guidance constants are imported, not retyped (test compares against the source constant).

## Risks

- Over-filtering: a future cross-conversation tool use (agent on Telegram acting into Slack) would be blocked — acceptable: no such routing exists for canvas, and the affinity map is one line to change.
- Guidance bloat: capped at a compact block per provider; anything longer belongs in docs, not the prompt.
- Teams presentation exists but transport isn't live — guidance ships for it anyway (harmless, correct when TEAMS-1 lands).

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | tool projection provider-filtered; system prompts gain per-provider guidance |
| Data/schema | Unchanged by design | none |
| API | Unchanged by design | no control-plane surface |
| CLI/ops | Unchanged by design | none |
| UI | Unchanged by design | none |
| Docs | Changed | tool-provider-affinity.md classification |
| Tests | Changed | selection filtering, guidance rendering, prompt-compile assertions |

`user_facing: false` — agents see a cleaner tool list and better instructions; no human-facing surface changes.
