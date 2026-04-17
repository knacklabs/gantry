# Agent Continuity

Agent continuity is MyClaw's ability to help the next agent turn understand where the work stands without replaying raw chat history.

Continuity is not the same as memory.

- **Memory** stores durable knowledge: facts, preferences, decisions, corrections, constraints, and reusable procedures.
- **Continuity** turns remembered context into a working brief: what is active, what was decided, what matters now, and what should not be rediscovered.

## Why This Exists

A useful personal assistant should not start from zero after `/new`, compaction, restart, or a scheduled job. It should know enough to continue work safely:

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

2. Structured memory
   - `memory_items` for durable facts and decisions
   - `memory_procedures` for reusable workflows
   - `memory_chunks` for ingested markdown knowledge
   - SQLite as the live search source

3. Injected runtime context
   - Before an agent run, MyClaw builds a memory context block.
   - The agent runner appends that block to the user prompt.
   - The agent can also call memory MCP tools during the run.
   - After a successful run, reflection extracts durable memories.

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
- "Fact: default SQLite memory path is `~/myclaw/store/memory.db`."
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

## Provider Model

MyClaw supports provider-based memory storage.

### `sqlite`

Default provider.

- Stores memory in SQLite only.
- Uses `settings.yaml memory.sqlite_path` (default: `store/memory.db`).
- No markdown mirror.
- Best for simple installs.

### `qmd`

SQLite plus markdown mirror.

- Stores live search data in SQLite.
- Mirrors memory items and procedures to markdown files.
- Appends journal entries.
- Archives sessions as markdown when supported.
- Best when users want inspectable memory files.

SQLite remains the source of truth for search in both modes. Markdown is an audit and recovery layer, not the live query engine.

## Embeddings Are Optional

Continuity must work with embeddings disabled in `settings.yaml memory.embeddings.enabled: false`.

Without embeddings, MyClaw uses:

- exact text search
- token matching
- FTS/BM25 where available
- recency
- scope priority
- memory kind priority
- pinned/importance signals

With embeddings enabled, vector search can improve recall and deduplication. It must never be required to save memory, search memory, inject context, or continue work.

## User Controls

Current user controls:

- `myclaw status` for runtime state
- `myclaw doctor` for health checks
- `/new` to reset session state while preserving memory
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

## Acceptance Criteria

A working continuity system lets a fresh agent answer:

- What are we working on?
- What decisions have already been made?
- What user preferences matter here?
- What facts are relevant to this group?
- What remains open?
- What should I avoid saving as memory?

All of this must work without embeddings.
