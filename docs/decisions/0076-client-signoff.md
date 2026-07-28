---
status: accepted
confirmed_by: "ravikiranvemula"
date: 2026-07-28
---

# Client Signoff

## Context
Gantry already routes provider models through catalog aliases and existing
provider credential profiles. The client requested built-in support for
OpenAI `gpt-5.6-terra`, OpenAI `gpt-5.6-luna`, and xAI `grok-4.5`, including
the official pricing and capability metadata required by catalog, CLI,
settings, status, and cost-reporting surfaces.

## Decision
Proceed with the bounded MOD-1 story. Register the three models behind
catalog aliases using official provider metadata and the existing OpenAI and
xAI provider adapters and credential profiles. Do not expose raw provider
model IDs at public model-selection boundaries or widen the story into
unrelated model-management refactors.

## Consequences
Implementation must keep catalog, settings validation, CLI/status display,
documentation, and focused tests aligned. Provider keys remain external
secrets configured through existing credential flows; no credential value is
stored in model metadata or committed to the repository.
