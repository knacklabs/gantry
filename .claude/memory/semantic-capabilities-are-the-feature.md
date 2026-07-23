---
name: semantic-capabilities-are-the-feature
description: "Runtime-defined semantic capabilities (e.g. google.sheets.values.get wrapping gog) are the PRODUCT FEATURE, not legacy — granular tools projected with semantic meaning; zero code footprint is by design"
metadata: 
  node_type: memory
  type: project
  originSessionId: 968040bb-9312-4913-b84e-c735654be245
---

The capability model's whole point (user, 2026-07-13): granular tools (CLI
invocations, MCP tools, command templates) are projected WITH SEMANTIC MEANING
as reviewed capabilities. `google.sheets.values.get/update/append` wrapping the
gog CLI are runtime-defined `local_cli` semantic capabilities — the feature
working as designed. They live ONLY in runtime data (~/gantry/settings.yaml
selections + gantry.tool_catalog rows in Postgres) and correctly have ZERO code
footprint — never treat that absence as "orphaned/legacy".

**Why this memory exists:** a 2026-07-13 audit + cleanup briefly removed them
as "phantom" (jobs then blocked with Setup-needed) because the API labeled
every unversioned capability `version: builtin` (fallback bug, since fixed) and
because "no code reference" was misread as orphaned. They were restored same
day.

**How to apply:** hardcoded product/provider capability ids in CORE CODE are
violations; the same ids in runtime data are the product. Jobs declare these
capabilities as requirements (jobs.target_json), so removing a selection blocks
dependent jobs — check `gantry jobs` requirements before touching selections.
Raw `RunCommand(gog …)` rules in settings are the non-semantic duplicates and
are the trimmable part, not the capabilities. Related:
[[auto-permission-trust-pause]], [[agent-access-simplification]].
