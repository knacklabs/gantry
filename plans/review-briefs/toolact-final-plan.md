# Review brief — NOTIFY-1-T7 (universal tool-activity + structured job result)

## What this change delivers
A universal `tool.activity` terminal event for EVERY tool call on both worker
runtimes and both inline lanes (live + jobs), with a neutral projection that turns
a job's recorded actions into a structured result for ANY tool — no per-tool,
no per-provider code. Plus retention, deterministic ordering, and per-invocation
correlation/dedup.

## INTENDED design decisions — do NOT report these as findings
1. **Gantry tool correlation is response-`_meta`, by design (decision 0132).**
   The generic terminal event and the authoritative `capability_run` /
   `browser_action` event must share one `invocationId` to dedup. The authoritative
   event is emitted in the MCP subprocess and only has `taskId`; that subprocess
   NEVER receives the model `tool_use_id`, so request-side propagation is
   infeasible. Therefore, for GANTRY-OWNED families ONLY, the generic hook reads
   the tool result's private `_meta.invocationId` (= `taskId`) and falls back to the
   provider id. Third-party tools ALWAYS use the provider id and their result
   `_meta` is never read (the read is gated on `gantryOwnedToolActivityFamily`).
   This is secure (no third-party hijack) and is the only correlation the
   architecture supports. See `docs/decisions/0132-gantry-tool-correlation-response-meta.md`.
   Do not propose removing the `_meta` read or "always use the provider id".
2. **The denial event stays `job.tool_denied`** — tool denial is job-scoped
   (decisions 0115/0126); only `tool.activity` is universal. Not an inconsistency.

## Where real review attention helps
- Correlation/dedup correctness WITHIN the decision-0132 model (does a Gantry call
  dedup to one item; does a third-party tool named like a browser action stay
  distinct; does a rich denial win over a correlated generic failure).
- Neutral projection: family-aware keys/labels, singleton-only detail, failed-first
  ordering, `+N more` overflow, no per-tool/per-provider branching.
- Retention prunes both live (null jobId) and completed+notified job activity.
- No secret leakage in recorded detail; caller-visible browser/capability result
  shape unchanged.
- Both-runtime parity (anthropic hooks + deepagents lifecycle) and inline lanes.
