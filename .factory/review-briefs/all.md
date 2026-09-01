# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task CARDSIMPLE-1-T1

### Plan contracts

- **CARDSIMPLE-1-AC2**
  - Source: plans/active/CARDSIMPLE-1-one-permission-surface-family-wide-grants.md#acceptance-criteria
  - Statement: Allow on a simple command records the canonical family rule via the ONE shared synthesizer so a later run with different args proceeds without asking; a rail hit inside an allowed family asks and permits Allow-once only; pipes present no Allow; safe non-piped compounds resolve per-leaf; pinned local_cli matching unchanged.
- **CARDSIMPLE-1-AC4**
  - Source: plans/active/CARDSIMPLE-1-one-permission-surface-family-wide-grants.md#acceptance-criteria
  - Statement: existing unit and Postgres integration suites pass; tsc and check:architecture green; the AC1/AC2 preservation clauses hold.

### Reviewer focus

- Family-only: rails run solely when isFamilyRule; exact reviewed rules and capability grants byte-for-byte unchanged (the early return is preserved for them).
- The rail-hit allow_once|cancel is computed ONCE at the coordinator — no adapter-level duplication, no prompt framework.
- The shared helper is the sole synthesis source in all three lanes; the SDK lane must now reject pipes.
- One narrow decision amending 0040 only; 0121/0144/JOBPERM-2 linked as compatible-unchanged; 0134 accepted and untouched; autonomous stays classifier-free; pinned local_cli readiness matching unchanged.
