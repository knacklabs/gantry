---
name: background-task-kills-environment
description: Long-running background Bash tasks (>~10 min) get killed sporadically on this machine — not by the user; run long verifications in foreground chunks
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 84c1b7c7-db24-491d-bfe0-70b0db54c380
---

During the company-brain-core session (2026-07-07, ~02:00-03:00 local), three
long-running background Bash tasks were killed: a ~40-min codex exec
implementer, one autoreview run (~3 min in), and a full build+test pipeline
(mid-tests). The user confirmed they did NOT stop them. Shorter background
runs (4-6 min) completed fine. Likely OS/harness reaping or machine sleep.

**Why:** background kills silently discard exit status and can strand a
pipeline mid-way; partial state on disk survives but completion can't be
assumed.

**How to apply:** for verification pipelines (build, full test suites,
autoreview), prefer foreground execution split into chunks under the 10-min
tool timeout (unit suite ~2 min, integration ~2 min, build ~3 min each fit).
Reserve background runs for work that must overlap other orchestration, and
always re-check output files + exit markers after a kill instead of rerunning
blindly — codex implementer output survived its kill and was usable.
