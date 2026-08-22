# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task NOTIFY-1-T7

### Plan contracts

- **TOOLACT-1-J1**
  - Source: plans/active/NOTIFY-1-T7-deterministic-structured-job-result-from-recorded-run-actions.md
  - Statement: The three required tests toolact-projection, toolact-anthropic, toolact-deepagents are top-level it() calls named exactly by their id (not nested in a describe); each passes and its JUnit testcase name equals the id with the file attribute set

### Reviewer focus

universal emission on all 4 seams; provenance-gated _meta correlation/dedup; family-aware neutral projection; both-runtime parity.
