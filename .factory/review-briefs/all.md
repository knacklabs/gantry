# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task CHAN-3-T1

### Plan contracts

- **CHAN-3-AC1**
  - Source: plans/active/CHAN-3-job-runner-split-runactivejob-and-runquery-by-phase.md#acceptance-criteria
  - Statement: `runActiveJob` in jobs/execution.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, sequenced from a body whose own complexity is <= 15; no behaviour change.
- **CHAN-3-AC3**
  - Source: plans/active/CHAN-3-job-runner-split-runactivejob-and-runquery-by-phase.md#acceptance-criteria
  - Statement: No behaviour change: existing unit and Postgres integration tests pass unchanged (only new tests may be added); tsc, architecture check, unit + Postgres integration lanes green.
- **CHAN-3-AC4**
  - Source: plans/active/CHAN-3-job-runner-split-runactivejob-and-runquery-by-phase.md#acceptance-criteria
  - Statement: Branch based on main after PR #451 (CHAN-2).

### Reviewer focus

- every phase moved verbatim (call sites, not re-implementations)
- context built once carries every value the phases read
- try/finally lease-release ordering unchanged in the sequencer
- no existing test edited
- sequencer CC <= 15, every phase <= 25 by AST count

## Task CHAN-3-T2

### Plan contracts

- **CHAN-3-AC2**
  - Source: plans/active/CHAN-3-job-runner-split-runactivejob-and-runquery-by-phase.md#acceptance-criteria
  - Statement: `runQuery` in runner/query-loop.ts is split by phase into named functions in ONE sibling module, each with cyclomatic complexity <= 25, driven from a loop body whose own complexity is <= 15; no behaviour change.
- **CHAN-3-AC3-T2**
  - Source: plans/active/CHAN-3-job-runner-split-runactivejob-and-runquery-by-phase.md#acceptance-criteria
  - Statement: No behaviour change for the runner split: existing runner unit tests pass unchanged (only new tests may be added); tsc, architecture check, unit lane green.

### Reviewer focus

- every loop branch moved verbatim (guards, order, continues)
- context shares the accumulators/flags by reference (nudge state, visible text, stream flags)
- stream.end() sites and conditions identical
- only the two source-text tests changed, and only their readFileSync path
- dispatcher CC <= 15, every handler <= 25 by AST count
