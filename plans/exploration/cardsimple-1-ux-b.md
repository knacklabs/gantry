# UX hunt pass B: scope disclosure + old-rule migration (read-only, no edits, TIGHT — small pass)

Current checkout (main + family grants + settings tolerance). Audit ONLY these two areas, with file:line evidence:

1. Compound-scope disclosure: `npm test && git push` synthesizes per-leaf families (`npm *` + `git *`) but the card's familyScopeCoverageLines / firstPersistentRule may show only one. Can the user tell EVERYTHING that gets saved on Allow-for-future? Check the chat prompt composers, job permission card need rows (renderedGrantAtoms), and receipts.
2. Old exact-argv rules users saved before tonight (e.g. `RunCommand(gh issue view 42)`): do they still match (valid old path), get shadowed by new family rules, double-ask, or clutter settings? On a NEW allow of the same command, does the family rule stack alongside the old exact rule — any dedupe or is settings.yaml accumulating? And in scheduled-job readiness, do old exact grants still satisfy requirements after the toolRuleCoversRule change?

Output: numbered findings — user-visible symptom (one plain sentence), root cause file:line, severity (confusing|annoying|broken-workflow), smallest UX fix. One-line verdict. No edits.
