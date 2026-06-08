# Agent Continuity

Agent continuity is Gantry's ability to help the next agent turn understand where the work stands without replaying raw chat history.

Continuity is not the same as memory.

- **Memory** stores durable knowledge: facts, preferences, decisions, corrections, constraints, and reusable procedures.
- **Continuity** turns remembered context into a working brief: what is active, what was decided, what matters now, and what should not be rediscovered.

## Why This Exists

A useful agent runtime should not make an agent start from zero after `/new`, compaction, restart, or a scheduled job. It should provide enough context to continue work safely:

- what the current task is
- which decisions are already settled
- which preferences should be respected
- what facts are relevant to this group
- what changed recently
- what should not be stored as memory

The goal is practical continuity, not a fake emotional persona. The agent should be reliable, inspectable, and easy to correct.

## Current Runtime Model

Gantry currently has these layers:

1. Static prompt profile FileArtifacts
   - `scope: prompt-profile`, `path: <agent-folder>/SOUL.md`
   - `scope: prompt-profile`, `path: <agent-folder>/CLAUDE.md`

2. Structured memory in Postgres
   - flattened `memory_items` for durable facts, decisions, procedures, and
     references
   - recent session digests for continuation recall
   - `memory_candidates` for staged extracted facts
   - Postgres full-text search for lexical recall
   - vector recall inactive until memory item embeddings are fully indexed and
     queried

3. Host-driven continuity context
   - Host runtime injects a fresh digest-first continuity block for every run.
   - Recent session digests are injected before active durable memory items when
     persisted.
   - The agent can call memory search and save MCP tools during the run.
   - `/new`, manual `/compact`, and observed SDK auto-compaction boundaries
     capture continuation digests and stage memory extraction evidence.
   - Automatic durable promotion is dreaming-only.

This gives the baseline for continuity today: remembered facts and relevant context can be injected into the next run.

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
- "Fact: Gantry stores runtime and memory state in Postgres."
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

## Static Prompt FileArtifacts

Static prompt FileArtifacts are not memory dumps.

- `SOUL.md` defines personality, voice, and boundaries.
- `CLAUDE.md` defines stable agent-specific guidance.
- Shared `agents/shared` prompt projection is not a runtime input.
- Former shared operating rules are compiled from built-in generated prompt
  guidance so agents keep memory, continuity, privacy, tool-use, and
  communication defaults without reading a host-path shared prompt file.

Dynamic facts, task state, and open loops belong in structured memory and continuity context, not in static prompt FileArtifacts.

## Storage Model

Gantry stores live memory in Postgres.

- Runtime database: `GANTRY_DATABASE_URL`
- Runtime schema: `storage.postgres.schema` (default `gantry`)
- Transcript exports: generated from Postgres messages into `FileArtifact`
- Provider-session artifact rows and local SDK JSONL transcript files are not
  continuity inputs and are not backfilled into FileArtifacts during the
  stateless runner cutover. If transcript export is needed later, generate it
  from canonical Postgres messages/runs/events into a FileArtifact.

## Embeddings Are Optional

Continuity must work with embeddings disabled in `settings.yaml memory.embeddings.enabled: false`.

Without embeddings, Gantry uses:

- exact text search
- token matching
- Postgres full-text ranking
- recency
- scope priority
- memory kind priority
- pinned/importance signals

Embeddings are optional. When embeddings are enabled and item vectors have been
written by dreaming promotion/update workflows or resumable embedding backfill,
turn-time recall fuses lexical and vector candidates. It must never be required
to save memory, search memory, inject context, or continue work; query embedding
timeouts and provider pauses fall back to lexical recall.

## User Controls

Current user controls:

- `gantry status` for runtime state
- `gantry doctor` for health checks
- `/new` to reset session state immediately while preserving memory; the
  replaced session's continuation digest is finalized asynchronously
- `/compact` to ask the Claude Agent SDK to compact active context and collect
  continuation digests plus staged extraction evidence at the compact boundary
- default memory MCP tools available to agents: `memory_search`,
  `memory_save`, `continuity_summary`, and `procedure_save`; patch tools are
  reserved for reviewed admin flows
- `continuity_summary` for the current scoped memory subject, including active
  memory, staged candidates, review state, dreaming status, and last injected
  context
- the `file` MCP tool for shipped FileArtifact read/write/promote workflows;
  FileArtifacts are separate from durable memory and still follow virtual
  artifact scopes

Planned continuity controls:

- memory status/search/save commands for users
- memory inbox for uncertain extracted facts
- commitment list and completion commands
- richer user-facing continuity status showing current state, recent digest,
  and open loops

## Failure Rules

- If embeddings fail, fall back to lexical memory search.
- If reflection fails, do not block the agent response.
- If memory DB is unavailable, run without memory and report the health issue.
- If context is stale, regenerate it instead of reusing old IPC files.
- If a memory candidate contains secrets or raw logs, reject it.

## Acceptance Criteria

A working continuity system lets a fresh agent answer:

- What are we working on?
- What decisions have already been made?
- What user preferences matter here?
- What facts are relevant to this group?
- What remains open?
- What should I avoid saving as memory?

All of this must work without embeddings.
