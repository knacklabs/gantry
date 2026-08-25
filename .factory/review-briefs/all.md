# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task JOBPERM-1-T1

### Plan contracts

- **JP1-T1-C1**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: card raised not cancel; resume in place on Allow; rule persists + next-run silent allow
- **JP1-T1-C2**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: Browser: no card, host verdict awaited
- **JP1-T1-C3**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: Deny terminal, truthful texts
- **JP1-T1-C4**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: deleted paths source-asserted

### Reviewer focus

- single-cut honored: no parallel autonomous lane survives (v9 Deletions)
- no authority widening: persisted grant equals card-rendered scope
- 0121 intact: no classifier on autonomous runs; rails-first fast path
- resume correctness: held call resumes exactly once; deny stays terminal

## Task JOBPERM-1-T2

### Plan contracts

- **JP1-T2-C1**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: reconciler crash-safe (approve/deny/handoff re-driven)
- **JP1-T2-C2**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: living card: one per job, batch never covers unseen rows
- **JP1-T2-C3**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: lease/slot rules tested (skew, restart, overlap)
- **JP1-T2-C4**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: handoff keeps Deny; late approval never lost
- **JP1-T2-C5**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: stage-review P1 fixes implemented: stale-click rerun consent gate, revision-bound paging action, run-scoped rerun barrier, current-policy apply-time revalidation

### Reviewer focus

- crash-safety: decided needs can never strand a waiter; grants never widen past card-rendered scope
- one living card per job; batch never covers unseen/handed-off rows
- lease/slot rules: monotonic accounting, slot before any waking response
- v9 sections A2/A4/A5/A6/A7 + Core model are the contract

## Task JOBPERM-1-T3

### Plan contracts

- **JP1-T3-C1**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: equivalence class blocked incl. staged download-then-execute
- **JP1-T3-C2**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: unprojected: persisted grant, limited completion, no auto-rerun
- **JP1-T3-C3**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: catalog present and complete
- **JP1-T3-C4**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: provider contract tests x3 green; live scenarios 1-3 pass
- **JP1-T3-C5**
  - Source: plans/active/JOBPERM-1-chat-parity-permissions-for-scheduled-jobs.md#task-decomposition
  - Statement: carried T2 hardening: per-revision delivery tracking, ambiguous-send reconciliation, provider ack atomicity and limits, credential delivery-anchor, need-after-rails ordering, snapshot tool input, pagination slot release, compound-scope paging, and the durability-service file-size split

### Reviewer focus

- no permanent grant for the remote-content-execution class; truthful typed results
- unprojected: Completed-with-limits + human Run-again; never auto-rerun
- carried hardening complete; durability service split passes the architecture file-size gate
- v9 sections B/C/D + physics limits are the contract
