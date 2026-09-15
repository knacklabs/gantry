# UX hunt pass A: explanation gaps only (read-only, no edits, TIGHT — small pass)

Current checkout (main + family grants + settings tolerance). A prior partial pass confirmed the ordinary single-command prompt is provider-consistent; do NOT re-derive that. Audit ONLY what the user is TOLD in three situations, with file:line evidence:

1. Excluded shapes (pipe, npx/npm exec/pnpm dlx, interpreter, relative path): the card offers no "Allow for future". Does any copy explain WHY and what to do instead (exact once-allow / semantic capability), or does the button just silently vanish?
2. Rail hit or shim guard inside a trusted family (user allowed `npm` but `npm exec x` or `rm`-risky command asks again): what exact text does the user see (FAMILY_RULE_RAIL_HIT_REASON path, runnerShimBashLeafReason strings) — is it comprehensible to a non-engineer, and does it reach the rendered card or only internal decisionReason?
3. Stored-but-no-longer-valid grants (warn-and-skip tolerance, e.g. `RunCommand(npx remotion *)`): does the USER ever get a signal that a saved grant is no longer honored (settings warning surfaces anywhere user-visible?), or does the tool silently re-ask forever with no remediation path?

Output: numbered findings — user-visible symptom (one plain sentence), root cause file:line, severity (confusing|annoying|broken-workflow), smallest UX fix. One-line verdict. No edits.
