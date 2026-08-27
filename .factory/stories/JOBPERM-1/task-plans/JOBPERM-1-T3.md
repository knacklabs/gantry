# THIS RUN: ONE TEST EXPECTATION FIX ONLY. Everything is done and green
# except apps/core/test/unit/application/agent-prompt-capability-catalog.test.ts:331
# ("uses the hashed projection order...") which asserts an exact array missing
# the catalog's new (intended, item-2) trailing lines "Requestable next-run
# actions" / "- none". Update the test expectation to include them. Then run
# that file + the three jobperm files; all green. Nothing else.

# JOBPERM-1-T3 — Honest edges, catalog, provider contracts, carried hardening

Binding contract: plans/review-briefs/scheduled-job-permission-parity-design.md
(committed) sections B/C/D + physics limits + Core model. T1 lane and T2
durability are on this branch; T3 completes the story.

1. Hard-boundary equivalence class: durable-grantability rejects
   download-then-execute across calls (interpreter/executable consuming a
   fetched or mutable file is nondurable); typed reformulation results.
2. Unprojected approvals: grant persists; run ends "Completed with limits"
   naming the missing tool; [Run again now] human-only; request_access always
   callable; runner-prompt catalog of every requestable unprojected identity.
3. Provider contract tests (Telegram, Slack, Discord): card send,
   edit-to-checklist, revision+epoch-bound actions, unauthorized-actor
   rejection, stale-card clicks, retire/replace.
4. CARRIED T2 HARDENING (contractual AC5): per-revision delivery tracking;
   ambiguous-send bounded readback/retry before handoff; provider ack only
   after durable acceptance + provider limits; credential anchored at
   confirmed delivery; needs attach only after rails miss; snapshot retains
   policy-relevant tool input; pagination slot release; compound-scope paging.
5. SPLIT the durability service into cohesive modules (state machine /
   reconciler / card projection / provider actions) passing the architecture
   file-size budgets — no exceptions entries.
6. Tests: TOP-LEVEL it() ids jobperm-1-t3-hard-boundary-class,
   jobperm-1-t3-unprojected-limited-completion,
   jobperm-1-t3-provider-card-contracts in
   apps/core/test/unit/application/jobperm-edges.test.ts. Leave the tree uncommitted; the orchestrator commits.


# CONTRACT POINTERS (read on demand, do not re-validate)
Full binding text: plans/review-briefs/scheduled-job-permission-parity-design.md
(committed) — sections B (browser naming), C (request_access/catalog/
unprojected), D (truthful statuses), physics limits. Decision 0135 (renumbered 0144 at merge) accepted.
Parameters already ruled: 24h wait from confirmed delivery; 10 rows/page,
20-atom composite gate; host reconciler owns slots via existing lease; provider
edit semantics per 0124. START CODING at item 1; the test file already exists.
