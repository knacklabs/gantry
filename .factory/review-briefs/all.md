# Branch-wide plan-contract review brief

For each contract, emit a verdict — implemented | partial | missing — with file:line evidence, recorded as contract_verdicts in the quality artifact. Then review the diff normally; the contract check does not replace the quality/performance/security lenses.

## Task T1

### Plan contracts

- **T1-C1**
  - Source: plans/active/WEB-PROVIDERS-2-correct-registry-driven-credential-setup.md#Task Decomposition
  - Statement: Registry-derived credential metadata includes labels, help text, required flags, multiline hints, and configured field names without exposing secret values.
- **T1-C2**
  - Source: plans/active/WEB-PROVIDERS-2-correct-registry-driven-credential-setup.md#Task Decomposition
  - Statement: Vertex service-account JSON is the only registry field marked multiline.
- **T1-C3**
  - Source: plans/active/WEB-PROVIDERS-2-correct-registry-driven-credential-setup.md#Task Decomposition
  - Statement: Same-method browser PATCH can reactivate disabled credentials after merged validation and atomic persistence.
- **T1-C4**
  - Source: plans/active/WEB-PROVIDERS-2-correct-registry-driven-credential-setup.md#Task Decomposition
  - Statement: Failed merged validation leaves disabled credential state and stored values unchanged.
- **T1-C5**
  - Source: plans/active/WEB-PROVIDERS-2-correct-registry-driven-credential-setup.md#Task Decomposition
  - Statement: Bearer Control API and CLI disabled-rotation rejection behavior remains unchanged.
- **T1-C6**
  - Source: plans/active/WEB-PROVIDERS-2-correct-registry-driven-credential-setup.md#Task Decomposition
  - Statement: Configuration-check responses describe only Gantry-side credential resolution and projection, not upstream connectivity.
- **T1-C7**
  - Source: plans/active/WEB-PROVIDERS-2-correct-registry-driven-credential-setup.md#Task Decomposition
  - Statement: Automated coverage iterates every executable provider and authentication mode without real credentials or upstream calls.

### Reviewer focus

Conform to constitution/README.md and its modular-monolith, API, provider-boundary, and exception standards. Keep the narrow reactivation opt-in in the existing service and browser facade only; preserve the default Bearer/CLI rejection and never return secret values in metadata.
