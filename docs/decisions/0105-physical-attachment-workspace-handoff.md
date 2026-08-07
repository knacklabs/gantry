---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-04
stories: [CONTENT-2]
---

# Physical Attachment Workspace Hand-off

## Context

Inbound conversation attachments are downloaded in full and stored OUTSIDE
every agent workspace by deliberate isolation (an untrusted upload must not
sit where agent tools operate). Agents therefore receive only views —
extracted text via attachment_open, image blocks for capable models — and can
never run tools over the actual file (scripts over a CSV, proper conversion,
native model file reads, process-and-reupload). PR #379 recorded the native
PDF hand-off as blocked on exactly this boundary decision.

## Decision

Ravi (2026-08-04, in chat: "add support so the agent can access physical
files — no blocker"): cross the boundary deliberately via an
`attachment_materialize` tool with a QUARANTINE CONTRACT:

- Handles mint only from conversation-scoped host-issued refs (the signed
  attachment_open trust model); the runner never supplies paths or raw ids.
- The copy lands ONLY inside a dedicated quarantine subdirectory of the
  agent's CURRENT workspace, written via the hardened inbound writer
  (O_EXCL/noFollow), size-capped.
- Quarantined files are reachable by agent tools but NEVER auto-ingested
  into context; prompt guidance marks the directory's contents as untrusted
  data, not instructions.
- Materialization is explicit per file per request — no ambient mirroring of
  the attachment store into workspaces.

## Consequences

- Agents can process real files with any tool; models with pdfInput/
  imageInput can receive the physical file where the runner supports it.
- The isolation boundary survives in weakened-but-explicit form: crossing is
  per-file, logged, quarantined, and prompt-flagged rather than forbidden.
- Prompt-injection risk of file CONTENT is unchanged (attachment_open already
  exposed content); the new risk surface is tools executing over hostile
  file STRUCTURE, mitigated by the quarantine guidance and existing
  permission gates on tool execution.
