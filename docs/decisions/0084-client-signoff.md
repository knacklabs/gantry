---
status: accepted
confirmed_by: "Yash"
date: 2026-07-28
---

# CONV-001 Client Signoff

## Context
Gantry already supports installing one agent into multiple conversations, but operators lack a guided setup flow and currently edit `settings.yaml` or use low-level commands.

## Decision
Yash approved CONV-001: add a guided **Add conversation to existing agent** setup flow that reuses the agent's existing Provider Account and credentials, validates the target conversation and approvers, and writes one additive canonical conversation install.

## Consequences
The implementation must not create an agent, reconnect or overwrite credentials, or modify unrelated conversations. Cancellation before confirmation writes nothing, and the resulting topology change preserves the existing restart-required contract.
