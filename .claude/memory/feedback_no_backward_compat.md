---
name: No backward-compatibility concerns
description: For myclaw, do not flag backward-compatibility concerns in code reviews — the user explicitly said "no need backward compatible"
type: feedback
originSessionId: 4e3225fe-b54c-4833-a90e-f7ef3142a731
---
For the myclaw project, do not flag backward-compatibility concerns in code reviews, plans, or refactor proposals. Behavior changes, schema relaxations, dropped fields, response-shape changes, and contract drift are all acceptable.

**Why:** The user explicitly said "No need backward compatible" during a /review session on the codex/unified-app-scoped-ingress branch (PR #66). The project is in active development and the user does not want time spent worrying about pre-existing API consumers.

**How to apply:** When reviewing or refactoring myclaw code, drop findings whose primary justification is "this changes existing API/wire/storage contract for current callers." Still flag genuine bugs that look like accidental contract changes (e.g. a refactor that drops a critical filter and silently broadens query scope) — but classify them as correctness issues, not backward-compat issues, and only if the new behavior is itself wrong. Do not introduce shims or compatibility layers in implementation either.

**Migration history is also mutable.** No environment runs prior migrations — confirmed by user 2026-05-14 with "no legacy". Deleting/renumbering Drizzle migrations from `_journal.json` and removing migration `.sql` files is OK; do not flag "migration X was applied to env Y, the journal must be append-only." Do not insist on writing follow-up `DROP COLUMN`/`DROP TABLE` migrations to clean up tables created by removed migrations — those tables don't exist anywhere. Still flag forward-looking schema correctness issues (missing FKs on new tables, dead schema definitions vs. live tables in code, etc.).

Sharpened 2026-07-19 (user: "There are no old users"): zero deployed users
beyond the user's own machine. No upgrade-path code, no migration preservation
logic, no legacy-shape tests, no compat shims — anywhere. Breaking drops get a
one-line comment at most. The single exception: the user's live machine data
(conversations/memories/jobs) — protected via deploy runbook steps (documented
in cycle ledgers), never via code.
