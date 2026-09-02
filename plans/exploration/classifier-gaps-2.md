# Auto-mode gap: learning / not re-asking — FAST pass (read-only, emit quickly, do NOT explore beyond the listed files)

Read ONLY these, then emit — do not grep the wider tree:
1. `apps/core/src/runtime/permission-classifier.ts` lines 300-420 (promotion counter read + how wasRecentlyApproved/wasRecentlyDenied feed the verdict)
2. `apps/core/src/application/permissions/permission-suggestion-synthesis.ts` (permissionSuggestionKey)
3. `apps/core/src/domain/permission-effect-key.ts` (whole file)

TARGET: like Claude Code auto mode, a human decision should be LEARNED so the same effect is not re-asked. Answer with file:line + concrete minimal proposal:

1. Do promotion counters / decision memory actually SUPPRESS a repeat ask, or only bias the LLM prompt text? Is a human "allow once" outcome recorded so the next IDENTICAL request auto-allows, or is it forgotten and re-asked?
2. Effect-key scoping: does the promotion/verdict key make genuinely-identical requests share history while keeping different ones apart? Flag any over-collide (family rule shared across different args) or under-collide (exact args so repeats never match) that defeats learning.
3. For shims/pipes/excluded shapes that can't hold a durable grant, is there ANY lighter learning so a scheduled job doesn't ask every single run, or is re-ask-every-run unavoidable today?

OUTPUT: numbered findings — gap, file:line, why it re-asks vs the ideal, minimal proposal, target story (ASKFLOOR-1 | CARDSIMPLE-2 | new). Under ~400 words. No edits. Emit as soon as the files are read.
