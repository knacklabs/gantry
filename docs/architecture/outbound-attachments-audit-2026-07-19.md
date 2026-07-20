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

| Provider | Delivers?          | Method                                                                            | Notes                                                                                                    |
| -------- | ------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Telegram | YES                | `sendDocument` per file (`telegram/file-delivery.ts:15-51`)                       | 50 MB own check; loud per-file fallback WITH reason; never sendVideo/sendPhoto                           |
| Discord  | YES                | multipart POST with Blobs (`discord-delivery.ts:55-219`)                          | 25 MB; visible warnings; contentType respected                                                           |
| Slack    | **SILENTLY DROPS** | none — `sendSlackMessage` never reads `files` (`channel-delivery-helpers.ts:136`) | text still lists phantom "Attachments:" lines                                                            |
| Teams    | STUBS              | none                                                                              | `teams-cards.ts:89-107` rewrites EVERY attachment line to the stub, including successfully resolved ones |

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
4. **Teams**: degrade all attachment lines honestly to the unavailable stub;
   the real fix remains signed artifact links.
5. **Telegram polish (optional)**: pick sendVideo/sendPhoto by contentType.

Status: Items 1-4 implemented in the outbound-attachments fix cycle. Teams
degrades all attachment lines honestly to the unavailable stub until signed
artifact links add real delivery in future work.

## Validation addendum (2026-07-19, adversarial Codex review of the uncommitted fix on `fix/outbound-attachments`)

Confirmed: loud reason-bearing failures + one `logger.warn` with
appId/agentId/scope/path/reason; Teams matcher prefix-safe against the new
failure strings inside the attachment section only; Telegram/Discord untouched;
Slack API sequence matches the documented external-upload contract.

Findings from the validation loop (ALL fixed before commit; the TOCTOU fix below was superseded twice — final containment is the platform-atomic open: darwin `O_NOFOLLOW_ANY`, linux `O_NOFOLLOW` + `/proc/self/fd` re-resolution, plus `nlink === 1` hardlink rejection):

1. **HIGH — containment TOCTOU** (`workspace-message-attachment.ts`): stat+read
   reopen the pathname after the realpath check; symlink swap escapes the
   workspace, large-file swap allocates unbounded. Fix: FD-bound — open canonical
   path with O_NOFOLLOW, fstat gate (regular file, size ≤ cap) BEFORE reading,
   capped read from the handle; ponytail-comment the residual ancestor-swap
   window (openat2/RESOLVE_BENEATH would close it).
2. **HIGH — Slack `files:write` scope** missing from BOTH setup scope lists
   (`setup-flow-provider-steps.ts`, `cli/slack.ts`) — uploads would always fall
   back on standard installs.
3. **MEDIUM** — upload + visible-fallback double failure currently reports
   success; must surface as failed delivery for that file.
4. LOW — Teams `inAttachments` flag never resets (section must end at first
   non-list, non-blank line). LOW — workspace paths must not reuse the
   FileArtifact segment grammar (spaces/Unicode rejected); realpath containment
   is the boundary for workspace resolution. MINOR — include caught error
   message in the warn fields; verify `resolveOwnedFileArtifactMessage` wiring
   is production-reachable (validator: wrapper references are test-only).
