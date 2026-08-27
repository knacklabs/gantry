---
status: proposed
confirmed_by: ""
date: 2026-08-27
stories: [VOICE-1, PKG-1]
---

# What is MIT and what is KnackLabs-licensed

## Context

The repository is MIT. The voice engine lives in a separate KnackLabs repository consumed as a dependency (0136) with no licence stated; client connectors may follow. Buyers of "self-hosted, any model" and OSS contributors both ask what is actually open.

## Decision

Everything in this repository is MIT, including the connector platform and in-repo connector kinds. The voice engine and any client-specific connector built inside an engagement are KnackLabs-licensed unless explicitly released; their licence is stated in their own repository and listed in NOTICE here. CI generates NOTICE and a dependency licence report per release tag.

## Consequences

- No surprise for contributors or clients; procurement gets a file.
- Moving a KnackLabs-licensed component into MIT is a deliberate release, recorded as a decision.
