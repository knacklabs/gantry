# ASKFLOOR-1-T3b task-contract grill — round 6 answer (gpt-5.6-sol @ xhigh; first launch died on the Codex compact-404 bug, relaunched)

1. **Residual stale-match wording contradicts the owner ruling.** Technical Approach step 1 ("rail version compared in code so stale is cheap"), the Risks line ("the stale line"), and the reviewer guidance ("else the first stale match flagged stale") still describe the removed design. Fix: filter the current rails version in SQL; remove the stale sentence; delete the reviewer clause.

Non-blocking: ACs, `plan_contracts` and saved-plan text byte-equal; every round-5 fold present (inline cache bypass, root fallback without an IPC edit, current-version precedence, `kind:tool` match/miss, sixth scope-key leaf); 17 files within 18/1,800; no T3c/T4/T5 surface; six leaf titles valid; inline file 739/750; `runtime-services.ts` needs no edit.

## Fold (orchestrator, contract v7 / plan v7 — wording only, no further round per the owner rule)

Step 1 now says the query carries `rail_version = railVersion` and `revoked_at IS NULL`; the Risks sentence names only the two reason lines; the reviewer guidance says "active rows of the current rails version only, first match in caller order".
