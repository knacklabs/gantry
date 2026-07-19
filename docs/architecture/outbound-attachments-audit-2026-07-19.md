# Outbound attachment delivery audit — 2026-07-19

Trigger: live incident — agent rendered an MP4, chat showed "- Attachment
unavailable." with no log line. Read-only audit of the full outbound path.

## Root cause of the incident

Mode (b): no artifact descriptor. `send_message` files resolve ONLY against the
FileArtifactStore (`send-message.ts:73-134`), but **a binary workspace file
cannot enter that store through any agent-facing path**:
- No auto-registration/scan of the agent workspace exists.
- The `file` tool's write path caps content at 2,000,000 base64 chars
  (~1.5 MB binary) — `ipc-file-artifact-handlers.ts:279`. A real MP4 can't fit.
- `normalizeFileArtifactPath` rejects absolute paths (`virtual-path.ts:14-34`).
- Neither the tool description (`runner/mcp/tools/messaging.ts:403-415`) nor
  the system prompt explains the register-first requirement.

Four failure modes (no store wiring / no descriptor / >25 MB cap / read
exception) collapse to one opaque line with a SILENT catch — zero logging.

## Provider delivery matrix

| Provider | Delivers? | Method | Notes |
|---|---|---|---|
| Telegram | YES | `sendDocument` per file (`telegram/file-delivery.ts:15-51`) | 50 MB own check; loud per-file fallback WITH reason; never sendVideo/sendPhoto |
| Discord | YES | multipart POST with Blobs (`discord-delivery.ts:55-219`) | 25 MB; visible warnings; contentType respected |
| Slack | **SILENTLY DROPS** | none — `sendSlackMessage` never reads `files` (`channel-delivery-helpers.ts:136`) | text still lists phantom "Attachments:" lines |
| Teams | STUBS | none | `teams-cards.ts:89-107` rewrites EVERY attachment line to the stub, including successfully resolved ones |

## Pattern classification (bug-pattern habit)

All three families stacked: **same-fact-twice** (workspace file vs. artifact-
store copy, unlinked, with a pipe too narrow to sync them), **silent failure**
(empty catch, 4 causes → 1 string), **incomplete provider matrix** (2 deliver,
1 drops, 1 stubs).

## Prioritized fix plan

1. **Loud failures (minimal, first)**: reason-bearing lines ("not found in
   FileArtifacts", "exceeds 25 MB", "invalid path: …") + `logger.warn` with
   appId/agentId/scope/path at the three collapse points
   (`send-message.ts:99-104,126-128,136-143`). Keep Teams' line-matcher
   compatible (`teams-cards.ts:99`).
2. **Workspace-direct resolution (the capability unlock)**: let `send_message`
   files reference the agent workspace — resolve `path` against the agent's
   workspace folder host-side, stat+read ≤25 MB, infer contentType, optionally
   auto-register into the store as a send-time side effect. One normalizer in
   `resolveCoreMessageAttachments`; no new tool, no base64 IPC hop.
3. **Slack upload adapter**: wire `options.files` to
   `files.getUploadURLExternal`/`completeUploadExternal`.
4. **Teams**: stop rewriting successfully-resolved lines; real fix remains
   signed artifact links.
5. **Telegram polish (optional)**: pick sendVideo/sendPhoto by contentType.

Status: QUEUED as the next lane-2 cycle after the ponytail audit converges.
