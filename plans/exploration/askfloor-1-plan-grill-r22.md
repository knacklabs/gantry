# ASKFLOOR-1 PLAN grill — round 22, AMENDMENT (read-only, adversarial, emit under ~250 words; factory/prompts/griller.md --gate plan)

You did NOT author this plan. Round 21 returned 3 blockers + 1 gap. `plans/exploration/askfloor-1-plan-source.md` (skip the frontmatter decision list) was revised:
1. The non-own-destination `send_message` row is removed from the table (stated principle only; no destination-bearing tool exists; 0052 birthright unchanged) — AF-AC1/AC4, Scope, §2, Decisions.
2. Scheduler/admin rows IMPORT the registry's canonical sets (`shared/admin-mcp-tools.ts:32-39,129-159`, incl. pause/resume/run-now and the authority/dispatcher/delegation/decision-actor buckets); malformed shapes = failing the tool's own schema → `ambiguous`; `file` has a discriminated per-action predicate (AF-AC2); valid-and-malformed test per row.
3. `/permissions` stays the human-memory ledger; auto-allows are visible via typed provenance + the audit trail (Risks, Decisions).
4. Surface Impact Docs lists 0155.
Also: browser `upload` of a protected/secret path is the protected-writes row; 0155 amends 0052's browser reading (owner choice).

Verify each is closed; hunt anything NEW. OUTPUT: numbered findings — claim, file:line, class, severity (blocker|gap|nit), smallest fix. OWNER-LEVEL questions verbatim (none if none). End with "PLAN SOUND" or the blocker count. No edits.
