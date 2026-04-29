# Agent Continuity

Agent continuity is MyClaw's ability to resume explicit session/current-work
state without replaying raw chat history.

Continuity is not the same as memory.

- **Memory** stores durable knowledge: facts, preferences, decisions, corrections, constraints, and reusable procedures.
- **Query-retrieved memory context** is the bounded memory evidence that matches the current user message or scheduled job prompt.
- **Continuity** is explicit resume/current-work state, such as provider session resume, current state, open commitments, and recent digest context.

## Why This Exists

A useful personal assistant should not lose durable knowledge after `/new`,
compaction, restart, or a scheduled job. It should retrieve enough relevant
context to continue work safely when the current request asks for it:

- what the current task is
- which decisions are already settled
- which preferences should be respected
- what facts are relevant to this group
- what changed recently
- what should not be stored as memory

The goal is practical continuity, not a fake emotional persona. The agent should be reliable, inspectable, and easy to correct.

## Current Runtime Model

MyClaw currently has these layers:

1. Static prompt profile files
   - `~/myclaw/agents/shared/CLAUDE.md`
   - `~/myclaw/agents/<group>/SOUL.md`
   - `~/myclaw/agents/<group>/CLAUDE.md`

2. Structured memory in Postgres
   - `memory_items` for durable facts and decisions
   - `memory_candidates` for staged extracted facts
   - `memory_items` for durable facts, procedures, and references
   - Postgres full-text search for lexical recall
   - `pgvector` for semantic recall when embeddings are enabled

3. Query-scoped memory retrieval
   - Host runtime uses the current message or scheduled job prompt as the memory retrieval query.
   - Matching memories are injected as untrusted evidence.
   - If no memory matches, no memory block is injected.
   - The agent can call memory MCP tools during the run.
   - After successful boundaries, extraction writes durable memories.

This gives the baseline today: durable facts are available, but a fresh session
does not silently continue an old chat unless the current user request or
agent-initiated `memory_search` retrieves relevant context.

## Target Continuity Model

The next continuity layer should add first-class current-state tracking on top of memory.

The agent-facing brief should become:

```text
[Continuity Brief]

Current State
- The active task or project state.

Open Commitments
- Promises, follow-ups, or unresolved loops.

Durable Memory
- Relevant preferences, decisions, facts, corrections, and constraints.

Dream Lifecycle
- Whether dreaming is enabled, its schedule, and last sweep outcome.

Relevant Procedures
- Reusable workflows that fit the current task.

Recent Digest
- Important recent changes worth carrying forward.
```

## What Belongs In Memory

Save durable, reusable statements:

- "User prefers direct engineering answers without filler."
- "Decision: embeddings are optional and provider-based."
- "Correction: do not store raw logs as memory."
- "Fact: MyClaw stores runtime and memory state in Postgres."
- "Procedure: before changing memory, run focused memory tests."

Do not save:

- raw terminal logs
- full transcripts
- temporary progress updates
- secrets or credentials
- vague importance scores without a real fact
- assistant narration like "I ran tests"

## What Belongs In Continuity

Continuity should track mutable work state:

- current task
- branch or project context when relevant
- open commitments
- blockers
- recent digest
- next likely action

This should not be stored as normal durable memory because it goes stale quickly.

## Static Prompt Files

Static prompt files are not memory dumps.

- `SOUL.md` defines personality, voice, and boundaries.
- shared `CLAUDE.md` defines broad operating rules.
- group `CLAUDE.md` defines stable group-specific guidance.

Dynamic facts, task state, and open loops belong in structured memory and continuity context, not in static prompt files.

## Storage Model

MyClaw stores live memory in Postgres.

- Runtime database: `MYCLAW_DATABASE_URL`
- Runtime schema: `storage.postgres.schema` (default `myclaw`)
- Provider continuation and transcript export artifacts: `ProviderArtifactStore`

## Embeddings Are Optional

Continuity must work with embeddings disabled in `settings.yaml memory.embeddings.enabled: false`.

Without embeddings, MyClaw uses:

- exact text search
- token matching
- Postgres full-text ranking
- recency
- scope priority
- memory kind priority
- pinned/importance signals

With embeddings enabled, vector search can improve recall and deduplication. It must never be required to save memory, search memory, inject context, or continue work.

## User Controls

Current user controls:

- `myclaw status` for runtime state
- `myclaw doctor` for health checks
- `/new` to reset provider/session state while preserving memory, approved skills, MCP bindings, model choices, and agent configuration
- `/compact` to archive the current transcript and continue
- memory MCP tools available to agents: `memory_search`, `memory_save`, `memory_patch`, `procedure_save`, `procedure_patch`

Planned continuity controls:

- memory status/search/save commands for users
- memory inbox for uncertain extracted facts
- commitment list and completion commands
- continuity status showing current state, recent digest, and open loops

## Failure Rules

- If embeddings fail, fall back to lexical memory search.
- If reflection fails, do not block the agent response.
- If memory DB is unavailable, run without memory and report the health issue.
- If context is stale, regenerate it instead of reusing old IPC files.
- If a memory candidate contains secrets or raw logs, reject it.
- If the user says "continue", "resume", or similar after `/new`, the agent should call `memory_search` instead of assuming hidden chat history.

## Acceptance Criteria

A working continuity system lets a fresh agent answer:

- What are we working on?
- What decisions have already been made?
- What user preferences matter here?
- What facts are relevant to this group?
- What remains open?
- What should I avoid saving as memory?

All of this must work without embeddings.
