# ASKFLOOR-1 SPEC grill — round 6, AMENDMENT (read-only, adversarial, emit under ~250 words; factory/prompts/griller.md --gate spec)

You did NOT author this spec. Round 5 returned 5 blockers; `docs/specs/askfloor-1-judge-actually-judges.md` and `docs/decisions/0155-default-allow-gantry-tools-interactive-auto.md` were revised:
1. Non-own-destination `send_message` is a stated PRINCIPLE, not a table row (no destination-bearing tool exists; `runner/mcp/tools/messaging.ts:385-429`; 0052 birthright unchanged; a future variant needs a new decision); AC1/AC4 say so.
2. The veto relaxation is `permissionMode === 'auto'` with no host-verified job id only (Behaviour §2 corrected).
3. Browser network side-effects auto-allow by explicit owner choice (offered and declined 2026-09-03); 0155 AMENDS 0052's browser reading, leaves 0052's shell-egress and secret floors untouched; browser `upload` of a protected/secret path is the protected-writes row.
4. `file` has a discriminated per-action predicate (list: scope; read: artifactId xor scope+path; write: scope+path+content; promote_scratch: targetScope+targetPath; else ambiguous → classifier).
5. Scheduler/admin rows IMPORT the registry's canonical sets (`shared/admin-mcp-tools.ts:32-39,129-159`, incl. pause/resume/run-now and the authority buckets). 0155 is accepted at plan re-approval.

Verify each is closed; hunt anything NEW. OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "SPEC SOUND" or the blocker count. No edits.
