---
name: pr-descriptions-reader-first
description: PR descriptions must lead with the overall goal/why in plain terms so a reader understands the total feature, not just the technical delta
metadata:
  type: feedback
---

User feedback 2026-07-23: PR descriptions were "cryptic" — a reader can't tell what the total goal is.

**Why:** PRs are read by people who weren't in the build. Leading with the diff/stage jargon (e.g. "land S2 emission + S3a batch-core") assumes context they don't have.

**How to apply:** Every PR body opens with a short plain-language section — what the FEATURE/program is and what it does for users (the "why this exists") — BEFORE the technical detail. Structure: (1) **What & why** — the overall goal in 2-3 sentences a non-builder understands; (2) **What this PR delivers** — this slice in the arc, plainly; (3) technical detail / stages; (4) evidence; (5) e2e delta. Name the program, not just the story key. Applies to every PR the orchestrator raises. Related: [[e2e-required-for-merges]], [[no-session-links-in-prs]].
