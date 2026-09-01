# Family neutrality gap hunt — pass B: match-side symmetry + surfaces (read-only, no edits, TIGHT)

Audit the CARDSIMPLE-1 family-grant code on the current checkout. The minting side is confirmed neutral; hunt ONLY the consumption side:

1. **Match-side symmetry.** A stored family rule `RunCommand(<argv0> *)` must MATCH everywhere stored rules are evaluated or compared. Check every consumer that validates or compares rules WITHOUT the runtime argv matcher: `application/jobs/job-readiness-service.ts` / `job-tool-access-requirements.ts` (declared-requirement coverage), `shared/skill-action-capability-rules.ts`, promotion counters and their suggestion keys (`runtime/permission-classifier.ts` readPromotionCounter + suggestionKey derivation), the deterministic auto-permission gate, and any string-equality comparison of rules (settings mirror reconciliation, tool-binding lookups). Which would re-ask or mis-compare despite a stored family?
2. **Decision memory / verdict caches.** Do effect-hash keyed caches now carry dead weight for family-covered repeats (redundant but harmless) or any wrong reuse?
3. **Suggestion surfaces.** Wherever "Allow for future" renders (chat ask card, job permission card need rows, setup prompts), is the DISPLAYED and PERSISTED rule now the family rule, or does any surface still show/persist exact argv?

Output: numbered findings (claim, file:line, class gap|asymmetry|intentional, severity, smallest fix or deferral trigger). One-line verdict: NEUTRAL AND COMPLETE or gap count. No edits.
