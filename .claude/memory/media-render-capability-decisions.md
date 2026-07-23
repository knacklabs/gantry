---
name: media-render-capability-decisions
description: "Grill-locked media render feature (2026-07-20) — out-of-box, capability+skill, full pre-provision, env-facts guidance; proven single-process Chrome recipe"
metadata: 
  node_type: memory
  type: project
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

Locked 2026-07-20 (grill session) after the video-render incident: (1)
out-of-box in-sandbox rendering for new users; (2) carrier = `media.render`
semantic capability + bundled skill; (3) full pre-provision at setup
(hash-pinned chrome-headless-shell + ffmpeg + warm Remotion template,
~400 MB); (4) generalize via a generated environment-facts section in worker
operating guidance; (5) lane started immediately in parallel (worktree
`wt-media`, `feature/media-render-capability`).

**Why:** root cause of the incident class = sandbox provisioned blind;
capabilities discovered by failure. Empirical proof on this machine: full
Remotion 4.0.290 render (210 frames) succeeded under srt with pinned
chrome-headless-shell + `--single-process --no-sandbox` wrapper + writable
HOME/TMPDIR + `network.allowMachLookup` gaining
`com.apple.SystemConfiguration.configd` + `allowLocalBinding: true`. srt has
NO mach-register key, so multi-process Chrome is impossible under it by
construction — single-process is the whole trick. srt config keys nest
INSIDE `network` (flat keys silently ignored).

**How to apply:** goal doc `docs/architecture/media-render-goal-prompt.md`.
HARD GATE before declaring done: verify the recipe under the `direct` provider
(Agent SDK seatbelt — live default), which is predicted but unproven.

**V4 SHAPE (user, 2026-07-20, after 3 NOT-SAFE validation rounds on Stage 3):**
FACADE-PREFLIGHT v1 — provisioner + `media-render` facade + selected skill +
env-facts; the facade preflights the toolchain itself at invocation.
CUT from v1: semantic-capability registration, admission preflight, worker
advertisement, durable capability selection (YAGNI until a 2nd provisioned
capability exists). One focused validation round on the v4 delta; implementation
queues after the E2E-gate lane. Related:
[[semantic-capabilities-are-the-feature]], [[fixed-image-worker-mode]].
