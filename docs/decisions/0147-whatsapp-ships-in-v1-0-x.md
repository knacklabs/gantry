---
status: proposed
confirmed_by: ""
date: 2026-08-27
stories: [IDENT-3, WA-1, HANDOFF-1]
---

# WhatsApp and human handoff ship in V1.0.x (amends 0136)

## Context

Decision 0136 sequenced WhatsApp with voice in V1.1 because both need phone identity. On 2026-08-26 the product decision was that WhatsApp plus human handoff is the second proof — a customer support assistant — and belongs in V1.0.x; the roadmap and handover already say so, leaving 0136 contradicted.

## Decision

IDENT-3 phone identity, WA-1, and HANDOFF-1 ship in V1.0.x. Voice stays in V1.1 and remains a provider adapter per 0136; everything else in 0136 stands.

## Consequences

- Phone identity is built once in V1.0.x and reused by voice.
- LIFECYCLE-1 (anonymous-caller erase) ships alongside WA-1.
