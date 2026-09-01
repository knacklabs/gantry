# Family gap hunt — pass B2: promotion keys + suggestion surfaces (read-only, no edits, TIGHT — small pass)

Current checkout (feat/CARDSIMPLE-1-family-wide-grants). Two small questions, reading as little as possible:

1. Promotion counters and classifier verdict caches: do suggestion keys / effect-hash keys still key on exact argv such that family-covered repeats produce redundant machinery or wrong reuse? (`runtime/permission-classifier.ts` readPromotionCounter + suggestionKey derivation, decision-memory cache keys.)
2. Suggestion surfaces: wherever "Allow for future" renders (chat ask card, job permission card need rows, setup prompts), is the DISPLAYED and PERSISTED rule the family rule everywhere, or does any surface still show/persist exact argv?

Output: numbered findings (claim, file:line, class gap|asymmetry|intentional, severity, smallest fix). One-line verdict. No edits.
