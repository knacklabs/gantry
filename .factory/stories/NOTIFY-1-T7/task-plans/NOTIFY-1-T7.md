# NOTIFY-1-T7 — already implemented and verify-green; CONFIRM ONLY, make NO changes

## STOP
The universal tool-activity feature and all its hardening are ALREADY implemented
in the working tree and `python3 factory/scripts/verify.py` is GREEN. This run
exists only to bind the write launch to the recorded contract.

Do NOT change, revert, re-implement, rename, or "clean up" anything. Make ZERO edits.

## What is already in place (do not touch)
- Universal `tool.activity` terminal event on both worker runtimes (Anthropic SDK
  PostToolUse hook + DeepAgents lifecycle) and both inline lanes, with a
  per-invocation correlation id; live turns emit with null jobId.
- Neutral projection: family-aware keys/labels (browser/capability never collide
  with generic tools), counts, failed-first, `+N more` overflow, singleton-only
  detail. No per-tool/per-provider code.
- Generic events use the provider identity; Gantry-owned capability/browser events
  dedup via the private result `_meta`, gated on TRUSTED registration provenance
  (host allowed-tools + reserved `mcp__gantry__` namespace / registered-tool
  marker) — never a third-party tool by name. See decision 0133.
- Per-invocation inline provider-id binding; DeepAgents prefers provider
  `toolCall.id` over tracer `runId`; retention prunes live + completed-notified
  activity; denial stays `job.tool_denied` (decisions 0115/0126).
- Acceptance tests drive the real PostToolUse / DeepAgents lifecycle; the
  claude-agent-sdk-boundary integration test asserts the 3-hook PreToolUse array.

## Verify (already green)
`python3 factory/scripts/verify.py` is green. Make no edits. Do NOT run autoreview,
stage, or commit — parent-owned.
