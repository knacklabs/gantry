---
story: CONTENT-1
decisions_reviewed:
  [
    '0000-credential-broker-boundary',
    '0001-agent-runtime-platform',
    '0002-symphony-forge-adoption',
    '0003-early-stage-no-backcompat',
    '0004-gantry-naming-and-public-repo',
    '0005-runtime-stack',
    '0006-config-secret-source-boundary',
    '0007-settings-runtime-truth',
    '0008-storage-backend-cutover',
    '0009-canonical-domain-schema-cutover',
    '0010-claude-runtime-materialization',
    '0011-provider-session-artifact-store',
    '0012-browser-capability-boundary',
    '0013-runtime-event-exchange',
    '0014-external-ingress-vs-outbound-webhooks',
    '0015-model-catalog-and-cache-accounting',
    '0016-event-bus-outbox-boundary',
    '0017-jsonb-runtime-payload-boundary',
    '0018-provider-neutral-agent-execution-adapter',
    '0019-simple-permission-and-job-tool-lifecycle',
    '0020-mcp-source-vs-action-capability',
    '0021-capability-artifacts',
    '0022-delivery-vehicle',
    '0023-deployment-modes',
    '0024-locked-preset',
    '0025-settings-authority',
    '0027-process-roles-and-multi-live',
    '0028-agent-harness-selection',
    '0029-agent-communication-reaction-binding',
    '0030-agent-communication-reasoning-safety',
    '0031-send-message-files-authority',
    '0032-signed-artifact-links-deferred',
    '0033-teams-reactions-deferred',
    '0034-client-signoff',
    '0035-epics-approved',
    '0040-permission-execution-two-axis-model',
    '0041-client-signoff',
    '0042-decision-view-16k-prefix-stripped',
    '0043-classifier-risk-only-engine-authz',
    '0044-ci-runner-isolation',
    '0045-inbound-attachment-descriptor-writer',
    '0046-llm-process-local-admission',
    '0050-agent-removal-projection-cleanup',
    '0051-client-signoff',
    '0052-birthright-self-surface',
    '0053-permission-no-timeout-interactive',
    '0054-decision-provenance-and-risk-label',
    '0055-client-signoff',
    '0056-durable-cancellation-invariant',
    '0057-arch1-client-signoff',
    '0058-readonly-scheduler-birthright',
    '0062-perm6-client-signoff',
    '0063-perm7-client-signoff',
    '0064-client-signoff',
    '0065-perm8-client-signoff',
    '0066-race-1-skill-artifact-app-isolation',
    '0067-client-signoff',
    '0068-race-2-cluster-fenced-settings-projection',
    '0069-client-signoff',
    '0070-client-signoff',
    '0071-race-4-browser-profile-lock-aba',
    '0072-client-signoff',
    '0073-race-6-profile-mirror-version-guard',
    '0074-race-8-mandatory-atomic-async-admission',
    '0075-race-9-serialize-file-backed-settings-write',
    '0076-client-signoff',
    '0077-race-5-lease-loss-lifecycle',
    '0078-lat-3a-single-memory-hydration-per-turn',
    '0079-client-signoff',
    '0080-lat-3b-retain-authoritative-second-fetch',
    '0081-client-signoff',
    '0082-fence-1-durable-lease-generation',
    '0083-conv-001-client-signoff',
    '0084-client-signoff',
    '0085-lat-4a-fused-inbound-envelope-transaction',
    '0086-client-signoff',
    '0087-lat-5-durable-provider-history-coverage',
    '0088-client-signoff',
    '0089-thread-turns-read-channel-context',
    '0090-sender-allowlist-trigger-only',
    '0091-client-signoff',
    '0092-client-signoff',
    '0093-client-signoff-is-a-pinned-project-gate',
    '0094-conversation-file-trust-program',
    '0095-client-signoff',
    '0096-thread-recency-message-timestamp',
    '0097-public-session-conversation-aggregate',
    '0098-streamed-message-projection-timing',
    '0099-rate-limits-singleton-authority',
    '0100-mig-1-client-signoff',
    '0101-oidc-generic-google-first',
    '0102-runtime-hardening-audit-harvest',
    '0103-live-admission-terminal-retention',
    '0104-co-1-recovery-intent-reframe',
  ]
---

# CONTENT-1 — Provider content gaps: honest fallbacks, six quick fixes, Slack canvas CRUD

Critiqued by Codex over four rounds (18 findings folded); entering the gates.

## Prerequisite and baseline

This story branches from main AFTER PR #379 ("Complete document attachment
handling", currently green at 6369548e9, awaiting human merge) lands. #379
reshaped the exact surfaces this plan touches, so the plan is written against
its post-merge state, specifically:

- `apps/core/src/shared/provider-attachment-materialization.ts` — dispatch is
  bytes-first (`sniffAttachmentKind`: PDF header / zip EOCD / image magics),
  images ≤3MB deliver as payloads gated by model `imageToolResults`, and the
  final fallback for unrecognized binaries is a truncated-60KB base64 dump
  (`readAttachmentContent`, the `MAX_BINARY_OUTPUT_BYTES` branch).
- `apps/core/src/shared/provider-attachment-extraction.ts` — worker-isolated
  Office/PDF text extraction with size/time/output bounds and structural image
  validation (`validateDeliverableImage`).
- Model capability flags (`imageInput`/`pdfInput`/`imageToolResults`) exist on
  the catalog and project into runners via `GANTRY_MODEL_INPUT_MODALITIES`.
- `isTextLike()` governs which extensions read as raw text.

## Scope (Ravi, 2026-08-03)

IN: the six verified quick fixes + Slack canvas read/create/update.
OUT (explicit): Teams anything (folds into TEAMS-1 — see "Teams deferral"),
reading users' reactions, reading users' message edits, polls/pins (backlog).

## Task 1 — six quick fixes (one bounded task; every claim below was verified

by file:line inventory on 2026-08-03)

1. **Honest binary fallback.** Replace the base64-garbage branch in
   `readAttachmentContent` with metadata + type-aware guidance: name, MIME,
   size, plus a hint keyed on recognizable families — audio ("no agent lane
   accepts audio today; ask for a text summary"), video, archives ("ask for the
   specific file"), Apple iWork `.pages/.key/.numbers` ("export as PDF or
   Office"). A truncated base64 prefix of a binary is unreadable by every
   model in the catalog; it only wastes tokens and misleads. Text-like reads
   are untouched.
2. **`.eml` reads as text.** Add `eml` to the `isTextLike` extension list
   (RFC-5322 plain text). `.msg` (OLE binary) stays on the new guidance path.
3. **Slack snippet CREATE.** Implement the production `sendSnippetFallback`
   stub (`slack/channel-delivery.ts:58-62` returns null today; the warning
   telemetry path exists at `channel-delivery-helpers.ts:212-228`).
   Placement is pinned: the fallback receives the ORIGINAL oversized chunk at
   the point the planner's text budget fails, BEFORE any splitting/truncation.
   The UTF-8 byte size decides the vehicle BEFORE any upload call: ≤1 MB →
   snippet; >1 MB → plain `.txt` file. Full text is preserved either way;
   nothing is ever sent to the snippet path above Slack's limit. Durability semantics are explicit
   at-least-once: the upload two-step (`files.getUploadURLExternal` →
   `files.completeUploadExternal`, `slack/file-delivery.ts:29-49`) is keyed by
   the outbox delivery id in the filename; a crash between share and outbox
   acknowledgement may duplicate the snippet on replay, never lose it — the
   replay path is tested, and the duplicate carries the same id-stamped name
   so it is recognizable.
4. **Discord voice notes classified as audio.** In
   `discord-conversation-context.ts:394-416`, `audio/*` content types map to
   the audio kind (today only `image/` is special-cased, so voice notes land
   as generic files); with fix 1 they then get honest audio guidance.
5. **Telegram locations/contacts keep their data.** In
   `telegram/media-ingestion.ts:267-272`, replace the bare `[Location]` /
   `[Contact]` placeholders with the data already in hand: coordinates
   (and venue title when present); contact name + phone. Pure information
   gain, no new fetches.
6. **Discord embeds readable inbound.** In `discord-conversation-context.ts`,
   fold `message.embeds[]` human-readable text into the message body —
   title, description, url, fields, AND `author.name`, `footer.text`, and
   image/thumbnail/video `description` (embeds whose only text lives in
   those fields are fixture-tested) — — ≤4 embeds, ≤1KB each measured in UTF-8 BYTES, and the
   COMBINED body (native text + folded embeds) then passes through the
   router's existing aggregate message budget so folding can never bypass
   inbound context limits. Tests pin a maximum-size native body plus four
   multibyte embeds. No interactive semantics.

## Task 2 — Slack canvas read/create/update (feature)

**Step 0 — export spike (hard gate).** Canvases surface as Slack files
(`files.list?types=canvas`); the spike verifies an authenticated, bounded
download of a canvas file yields a usable text export end-to-end.
`canvases.sections.lookup` returns section IDs ONLY (no text), so there is no
API fallback for reading: if the export path fails, READ drops from this
story (create/update proceed) and the deviation is recorded on the decision.

A new canvas module in the slack channel adapter + host-side IPC handlers + three runner MCP
tools (`canvas_create`, `canvas_update`, `canvas_read`):

- **Trust boundary — host-issued handles, with READ and WRITE authority kept
  separate.** The runner NEVER supplies a raw Slack canvas id; tools accept
  opaque host-issued refs (signed conversation proof + host-side resolution,
  the `attachment_open` model). Two distinct capability sets per
  conversation, because read reachability must not confer mutation:
  - READ set: the channel's bound canvas, canvases created by the agent in
    this conversation, and canvases shared into the conversation — where
    "shared into" is minted ONLY from a conversation-bound inbound share
    event (a `file_share` carrying the canvas in THIS conversation's message
    stream), exactly like attachment refs. `files.list` is NEVER used for
    handle minting: workspace visibility is not conversation reachability.
  - WRITE set: ONLY the channel's own bound canvas and canvases the agent
    created in this conversation. A canvas merely shared in is read-only
    here even if the bot happens to hold write access via another channel —
    closing the confused-deputy cross-conversation write path.
    `canvas_update` handles are minted exclusively from the WRITE set.
- **Create:** `canvases.create` with markdown `document_content` AND the
  host-derived conversation channel as `channel_id`, so the canvas is created
  in — and visible to — the requesting conversation (also the required shape
  on free-plan workspaces, where standalone canvases are unavailable). The
  response permalink is surfaced in the tool result; the id enters both
  capability sets. Free-team limit handled explicitly: one canvas tab per
  channel — on `free_team_canvas_tab_already_exists` the tool returns the
  EXISTING bound channel canvas (as a read/write handle under the normal
  rules) with a message saying creation was unnecessary; fixture-tested. A
  paid-plan standalone-canvas variant is explicitly NOT offered in v1.
- **Update:** `canvases.edit` operations. Section targeting uses HOST-ISSUED
  section handles: the host runs `canvases.sections.lookup`, returns labeled
  handles to the agent, and an update against zero or multiple matches fails
  explicitly (listing candidates) instead of guessing. Concurrency is stated
  honestly: `canvases.edit` has NO revision/CAS parameter, so Slack applies
  last-write-wins. The host serializes ITS OWN operations per canvas (one
  in-flight edit per canvas id), and destructive whole-document `replace` is
  gated behind a fresh section lookup in the same tool call; concurrent HUMAN
  edits remain unprotected and the tool description says so; Slack's explicit
  edit-lock/conflict error responses surface to the agent as a retryable
  message rather than a crash. Tests: duplicate headings, no match, stale
  handle rejection, lock-error surfacing, host-side serialization.
- **Read:** via the spike-verified file export, through the normal bounded
  text path.
- **Scopes — installation contract, not just doctor.** `canvases:read` +
  `canvases:write` enter the CANONICAL install surfaces: the Slack app
  manifest/OAuth scope list used by setup, the setup flow's authorization
  step, and the doctor check — with an actionable re-authorization path for
  existing workspaces. Tests cover a fresh install's requested scope set and
  an upgraded install detecting+reporting the missing scopes.
- **IPC payload validation (host side, strict).** Canvas tools relay
  runner-controlled content, so the IPC handlers enforce byte/shape bounds
  before any provider call: markdown ≤150 KB UTF-8, title ≤300 chars,
  EXACTLY ONE edit operation per `canvas_update` call (matching the
  `canvases.edit` one-change-per-call contract), operation enum allowlisted,
  strict schemas (unknown fields fail loudly per repo policy). Oversize or
  malformed input returns a bounded error without touching Slack; each bound
  is unit-tested at its boundary.
- **Permalink:** `canvases.create` returns only `canvas_id`; the permalink
  comes from a follow-up `files.info` (canvases are files). `files:read` is
  verified against the canonical scope list (already present for attachment
  downloads); if the lookup fails the tool result omits the permalink
  non-fatally and says so. The fake-HTTP tests cover the `files.info` call
  and its failure path.
- **Outbound durability:** canvas operations are direct tool calls in the
  agent's turn (rich-interaction category), NOT durable-outbox messages; no
  sanitizer/allowlist changes.

## Teams deferral (recorded, not implemented here)

TEAMS-1's roadmap entry gains acceptance criteria so these aren't lost:
implement `updateAdaptiveCard` (declared `teams-types.ts:113`, unimplemented),
outbound file delivery (today dropped with a text notice, `teams.ts:253`),
and the Teams equivalents of the fallback-guidance behavior once Graph file
capture (FILE-1C) lands. No Teams code changes in this story.

## Verification

- Unit: fallback guidance per family (audio/video/zip/iWork/unknown), `.eml`
  text read, Discord audio classification, Telegram location/contact payloads,
  Discord embed folding (bounds pinned), snippet-fallback upload (fake
  provider client, asserts two-step upload + post), canvas module (fake HTTP:
  create/edit/lookup request shapes + scope-error surfacing).
- Integration: attachment fallback cases ride the existing materialization
  suites; canvas IPC handler scope-validation mirrors the attachment_open
  proof tests.
- Full unit lane + integration lane locally before push (the #379 lesson:
  focused runs escape), format/architecture gates, verify.py.
- Live smoke (this runtime): post an oversized message → snippet appears;
  agent creates + updates a canvas in a test channel; share a voice note on
  Discord and a location on Telegram → honest content.

## Risks

- Snippet fallback changes visible behavior for oversized messages (file
  instead of truncated text) — deliberate, called out in PR.
- Canvas read via file-export is the one empirically unverified seam — hence
  the hard spike gate; there is NO API fallback (sections.lookup has no text).
- New Slack scopes require app re-install in workspaces; doctor must say so
  plainly rather than half-working.
- Embed folding grows message text; bounds keep it under router budgets
  (`attachmentsPerMessage`/byte caps unchanged).

## Surface Impact

| Surface          | Class               | Reason                                                                                   |
| ---------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| Runtime behavior | Changed             | fallback guidance, snippet/file uploads, richer Telegram/Discord ingestion, canvas tools |
| API              | Unchanged by design | no control-plane or SDK surface changes                                                  |
| Data/schema      | Unchanged by design | no migrations; canvas handle sets are in-memory conversation state                       |
| CLI/ops          | Changed             | setup doctor learns the canvas scopes with re-auth guidance                              |
| UI               | Unchanged by design | none exists for these surfaces                                                           |
| Docs             | Changed             | Slack app scope/install note                                                             |
| Tests            | Changed             | per Verification section                                                                 |

`user_facing: false` — no UI surface (agent tools + ingestion changes); the
live smoke in Verification covers user-visible behavior in place of a
UI functional check.
