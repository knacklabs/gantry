# Family gap hunt — pass B1: match-side symmetry ONLY (read-only, no edits, TIGHT — small pass)

Current checkout (feat/CARDSIMPLE-1-family-wide-grants). Contract already established: family grants use the existing matcher grammar, never mutate job declarations, and family matches are provisional to exact-command rails plus the runner-shim guard. Audit ONE question, reading as little as possible:

A stored family rule `RunCommand(<argv0> *)` must MATCH everywhere stored rules are evaluated or compared. Find any consumer that compares rules by string equality or exact argv instead of the runtime matcher and would re-ask or mis-compare despite a stored family: `application/jobs/job-readiness-service.ts` / `job-tool-access-requirements.ts` (declared-requirement coverage), skill-action capability rules, the settings mirror reconciliation, tool-binding lookups. Distinguish intentional declaration immutability from accidental exact-rule comparison.

Output: numbered findings (claim, file:line, class gap|asymmetry|intentional, severity, smallest fix). One-line verdict. No edits.
