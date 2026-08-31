# CARDSIMPLE-1 validation pass 2 of 4 — family-breadth grants (read-only, no edits)

Scope ONLY this question; keep reading tight. The draft spec `docs/specs/cardsimple-1-one-permission-surface.md` changes Allow to record a durable command-FAMILY rule (allowing one curl invocation covers curl with any args in future runs), risk-gated so destructive shapes still re-ask.

Verify against code: where exact-argv rules are synthesized (`apps/core/src/application/permissions/permission-suggestion-synthesis.ts` commandRules; `apps/core/src/shared/bash-command-parser.ts` normalizeBashLeafRuleContent) and EVERY matcher that consumes RunCommand rules. Is a family/prefix rule shape already representable in the rule grammar and its matchers, or is that new grammar? Which risk-analyzer path (PERM-3 risk classifier lineage, decisions 0040-0042) would still force a fresh ask for a destructive command inside an allowed family — does the spec's "risk-gated" claim have a real enforcement point today, and where?

Output: numbered findings — claim, file:line, severity (blocker | design-gap | nit), smallest spec amendment. Nothing else.
