---
name: no-session-links-in-prs
description: Never add Claude session URLs to PR bodies or commit messages in this repo
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

No `claude.ai/code/session_...` links in PR bodies, and no Claude-Session /
Co-Authored-By trailers in commit messages, in the gantry repo.

**Why:** the user considers session links tooling metadata, not product
context — the repo history should read as product changes only. (Asked
"why are we adding the session url in the PR message", 2026-07-20; commit
trailers were already banned earlier.)

**How to apply:** when creating commits or PRs, omit the harness-default
session-URL footer entirely. If a PR was created with one, strip it via
`gh pr edit`.
