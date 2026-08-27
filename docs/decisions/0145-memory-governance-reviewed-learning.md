---
status: proposed
confirmed_by: ""
date: 2026-08-27
stories: [MEMORY-CONSENT-1, SELF-1, QUAL-1]
---

# Learning is a reviewed revision: no autonomous promotion (memory governance)

## Context

The brief promises that what an AI employee learns is a reviewable record, never autonomous drift. Today the dreaming job can auto-promote memory candidates (`apps/core/src/memory/app-memory-dreaming.ts`), DMs default to personal memory with no opt-out (`app-memory-subject-resolver.ts`), and SELF-1 will let agents propose changes to themselves. Three paths by which an agent's behaviour changes without a person deciding.

## Decision

Every change to what an agent knows or is told — memory promotion, personal memory in DMs, self-proposed revisions — passes one governance knob set per agent by its owner: **review** (a person approves each item, via the existing review flows or an approval card) or **auto-apply for named low-risk classes** with an ADMIN-ALERT-1 post and one-action reversal. Dreaming auto-promotion is disabled unless the owner enables it for that agent; locked-preset agents are review-only. People are told when personal memory is kept about them and can opt out or erase it (MEMORY-CONSENT-1).

## Consequences

- The BRIEF claim becomes true by mechanism, not by prose.
- One knob, three paths: memory, consent, self-revision share the same review/auto-apply model and audit shape.
- A console review surface for memory joins the directory work; until then the CLI review commands are the surface.
