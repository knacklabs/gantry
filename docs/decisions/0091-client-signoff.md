---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-30
---

# Client sign-off for GH-352: thread context restore + trigger-only allowlist

## Context

Grilled in-chat 2026-07-30 (AskUserQuestion, five decisions across two rounds
plus two follow-ups). The original premise — thread turns lack channel
background — failed measurement (signal `S-0001-2b7e`); the client confirmed
the revised scope.

## Decision

The client signed off on: thread window restored to 50 with **root + first 10
+ latest 39** long-thread selection; the existing thread-turn channel
background (30 top-level messages) pinned as a tested guarantee; the sender
allowlist becoming **trigger-only** with `mode: drop` removed and legacy
configs normalized at the parser; window sizes staying fixed; admin surface
staying settings.yaml. Governing records: decisions 0089 and 0090.

## Consequences

Planning may proceed. The mention-routing fix from `75e1f0617` is preserved;
its window shrink is reverted. D-0030 resolves via 0090.
