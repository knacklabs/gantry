# Memory, Continuation, Dreaming — Implementation Plan

**Status:** Ready for handoff, 2026-04-18
**Owner:** Ravi
**Audience:** coding agent implementing this plan
**Scope:** Redesign three pipelines — turn-time extraction, session continuation, nightly dreaming — and surrounding cleanup/observability. Self-only rollout. Clean cutover. Haiku 4.5 for hot-path extraction, Sonnet 4.6 for session summary + nightly dream + consolidation. Embeddings stay optional.

---

## 0. Rules for the coding agent (READ FIRST)

These are non-negotiable. Violations = rework.

1. **No invented APIs.** Every function, type, table, column, or file reference below must be checked against the current code before use. If a type differs from what's written here, use the real one and flag the mismatch in your PR description. Do not silently rename.
2. **No fabricated file paths.** All paths are relative to `/Users/ravikiranvemula/Workdir/myclaw` (source) and `/Users/ravikiranvemula/myclaw` (runtime) unless otherwise noted. If a path doesn't exist, stop and ask — don't create arbitrary new ones.
3. **No invented configuration keys.** Use existing `apps/core/src/core/config.ts` exports when extending. Add new keys only in that file and document them in §12.
4. **Prompt text is verbatim.** Every prompt in §3, §4, §5 is drop-in. Do not paraphrase, shorten, or "improve" them unless updating this doc first.
5. **Few-shot examples are verbatim.** They are deliberate. Ship them in TypeScript as typed constants, not free-form strings.
6. **Strict JSON output from LLMs.** Use Anthropic SDK tool-use or JSON mode; reject any response that fails schema validation with a structured error (no silent fallbacks that mask bugs).
7. **Zero hallucinations in dream/consolidation.** Both prompts require "never invent content absent from inputs". Enforce by post-hoc string check: every name/ID/path in the output must appear in the input set. Reject if not.
8. **Clean cutover.** Bump `MemoryStore.SCHEMA_VERSION` from 3 to 4, drop existing tables, rebuild from scratch. Wipe the DB file and QMD mirror directories as part of Phase 2 below. Do not write a compat shim for v3.
9. **Embeddings are optional.** Every new path (extraction, consolidation, dreaming) must work with `EmbeddingProvider` disabled. Consolidation must fall back to lexical clustering when embeddings unavailable.
10. **Feature-flag new code.** Gate new extractor, new dreamer, new consolidation behind env flags (§12). Old paths remain wired until the flag flips.
11. **No logging secrets.** Never log full prompts or full LLM responses at INFO; redact and log at DEBUG only.
12. **Telemetry events are a contract.** §11 defines event names and payload keys. Use exactly those strings; downstream tooling greps for them.
13. **Tests must be added.** Eval harness in §13 is mandatory before cutover. Unit tests for each new function.
14. **Don't introduce new top-level dirs.** Stay within `apps/core/src/memory/`, `apps/core/src/session/`, `apps/core/src/runtime/`, `apps/core/test/memory-eval/`.
15. **Ask before destructive actions.** Hard-delete, file wipe, schema drop — confirm with Ravi before executing in the live runtime directory `/Users/ravikiranvemula/myclaw`.

---

## 1. Verified facts (trust these)

These have been verified in the current codebase as of 2026-04-18:

### File layout

- Memory module: `apps/core/src/memory/` contains `memory-types.ts`, `memory-store.ts`, `memory-service.ts`, `memory-retrieval.ts`, `extractor-llm.ts`, `extractor-types.ts`, `memory-consolidation.ts`, `memory-dreaming.ts`, `memory-embeddings.ts`, `memory-embedding-cache.ts`, `memory-item-search.ts`, `memory-ipc.ts`, `memory-root.ts`, `index.ts`.
- Session module: `apps/core/src/session/` contains `session-commands.ts`, `session-transcript-archive.ts`.
- Config: `apps/core/src/core/config.ts`.
- Runtime IPC + scheduler: `apps/core/src/runtime/ipc.ts`, `apps/core/src/runtime/task-scheduler.ts`, `apps/core/src/runtime/group-processing.ts`.
- Agent runner (MCP stdio + permission flow): moved into core runtime under `apps/core/src/runner/index.ts` and `apps/core/src/runner/ipc-mcp-stdio.ts`.
- Anthropic SDK already present as `@anthropic-ai/sdk` and used in `memory-consolidation.ts`.
- SQLite via `better-sqlite3` with `sqlite-vec` for vector search.

### Existing types (do NOT redefine, extend instead)

- `MemoryScope = 'user' | 'group' | 'global'` (`memory-types.ts:1`)
- `MemoryKind = 'preference' | 'decision' | 'fact' | 'context' | 'correction' | 'constraint' | 'recent_work'` (`memory-types.ts:4-11`) — **§5 drops `context` and `recent_work`**.
- `MemoryItem` (`memory-types.ts:13-35`) — full field list below in §2.
- `MemoryProcedure` (`memory-types.ts:37-50`).
- `SaveMemoryInput`, `PatchMemoryInput`, `SaveProcedureInput`, `PatchProcedureInput` (`memory-types.ts:92-128`).
- `MemoryStore.SCHEMA_VERSION = 3` (`memory-store.ts:46`) — bump to 4.

### Runtime paths

- Memory DB: `/Users/ravikiranvemula/myclaw/agent-memory/.cache/memory.db`
- QMD mirror: `profile/`, `procedures/`, `sessions/`, `journal/`, `.raw/`, `knowledge/` under `/Users/ravikiranvemula/myclaw/agent-memory/`
- Claude Code runtime settings: `/Users/ravikiranvemula/myclaw/.claude/settings.json`
- IPC root: `/Users/ravikiranvemula/myclaw/data/ipc/`
- IPC lock: `/Users/ravikiranvemula/myclaw/data/ipc/.lock`

### Known bugs surfacing alongside this redesign

- Stale IPC lock bug in `apps/core/src/runtime/ipc.ts` `acquireIpcRootLock` (~L224). No PID liveness check. Blocks permission + user-question flows. **Phase 0 fix.**
- Procedure fragments in current DB (titles starting with `"Found it. …"`, `"Findings: …"`, `"Critical: …"`) — assistant reasoning saved as procedures. **Phase 0 purge + Phase 2 prevention.**
- `settings.yaml -> memory.dreaming.enabled` defaults `false`; consolidation was previously gated and now runs by default when memory is enabled. **Phase 0 flip.**
- Consolidation scope counter mismatch: DB has 163 items, reflection loop reports `min_items_not_reached:50`. Investigate at `memory-consolidation.ts:44-59` (`listActiveItems(groupFolder, 10_000)` — group-scoped filter returns fewer than expected). **Phase 0 diagnose.**

---

## 2. Data model v4 (schema migration)

**Action**: bump `MemoryStore.SCHEMA_VERSION` to 4 in `memory-store.ts:46`, add a `migrateToV4()` method that drops v3 tables and recreates v4 from scratch. DB file wipe in Phase 2 makes this a clean build, not a data-preserving migration.

### `memory_items` (v4)

Keep all v3 columns AND add the following:

| Column             | Type              | Notes                                                     |
| ------------------ | ----------------- | --------------------------------------------------------- |
| `why`              | TEXT              | Short quoted justification from source turn.              |
| `load_bearing`     | INTEGER (0/1)     | LLM-reported; future decisions depend on it.              |
| `source_turn_id`   | TEXT              | Turn that produced this fact (nullable for manual saves). |
| `used_count`       | INTEGER DEFAULT 0 | Retrieved AND referenced in downstream output.            |
| `superseded_by`    | TEXT              | id of the replacement item.                               |
| `is_deleted`       | INTEGER DEFAULT 0 | Soft-delete flag.                                         |
| `deleted_at`       | TEXT              | ISO8601, set when `is_deleted=1`.                         |
| `last_reviewed_at` | TEXT              | Updated by dream sweep.                                   |

Drop `MemoryKind` values `'context'` and `'recent_work'` in v4 — migrate them to `'fact'` on import (not relevant for cutover wipe; relevant if we ever migrate instead). Update `memory-types.ts:4-11` accordingly.

Add unique constraint: `UNIQUE(scope, group_folder, key) WHERE is_deleted = 0` (partial unique index).

### `memory_procedures` (v4)

Keep v3 schema AND add:

| Column       | Type                                                      | Notes                        |
| ------------ | --------------------------------------------------------- | ---------------------------- |
| `origin`     | TEXT CHECK `origin IN ('explicit','accepted_suggestion')` | No auto-inferred procedures. |
| `trigger`    | TEXT                                                      | When this procedure applies. |
| `is_deleted` | INTEGER DEFAULT 0                                         | Soft-delete flag.            |
| `deleted_at` | TEXT                                                      |                              |

### `memory_usage_events` (new)

```sql
CREATE TABLE memory_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  turn_id TEXT,
  event TEXT CHECK(event IN ('retrieved','used','contradicted')) NOT NULL,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(item_id) REFERENCES memory_items(id)
);
CREATE INDEX idx_usage_events_item ON memory_usage_events(item_id);
CREATE INDEX idx_usage_events_at ON memory_usage_events(at);
```

### QMD mirrors

Mirrors at `profile/{id}.md` and `procedures/{id}.md` must be **deleted** when `is_deleted=1` is set. Add `deleteMirror(id)` calls in `softDeleteItem` and `softDeleteProcedure`.

YAML frontmatter keys for profile mirrors:

```yaml
---
id: string
scope: user|group|global
kind: preference|decision|fact|correction|constraint
key: string
confidence: 0..1
load_bearing: true|false
created_at: ISO8601
updated_at: ISO8601
---
```

---

## 3. Turn-time pipeline — extraction

### Trigger

After every user-assistant turn, inside `MemoryService.reflectAfterTurn()` (existing function, `memory-service.ts` around `:656`).

### Pre-filter (keep regex as gate)

Reuse the extraction pre-filter patterns in `extractor-llm.ts` for deciding **whether to call the LLM**. If zero pattern hits across the turn, skip the LLM call entirely and emit telemetry `extraction_skipped_prefilter`.

### New file: `apps/core/src/memory/extractor-llm.ts`

```ts
import Anthropic from '@anthropic-ai/sdk';
import {
  MODEL_EXTRACTOR,
  MEMORY_EXTRACTOR_MAX_FACTS,
  MEMORY_EXTRACTOR_MIN_CONFIDENCE,
} from '../core/config.js';
import {
  EXTRACTOR_SYSTEM_PROMPT,
  EXTRACTOR_FEW_SHOTS,
} from './prompts/extract.js';
import type { MemoryItem, MemoryKind, MemoryScope } from './memory-types.js';

export interface TurnContext {
  groupFolder: string;
  userId: string | null;
  lastUserMessage: string;
  lastAssistantMessage: string;
  priorTurns: Array<{ role: 'user' | 'assistant'; content: string }>; // up to 2 previous turns (so 3 total)
  retrievedItems: Array<Pick<MemoryItem, 'id' | 'key' | 'value'>>;
  turnId: string;
}

export interface ExtractedFact {
  kind: Exclude<MemoryKind, 'context' | 'recent_work'>;
  scope: MemoryScope;
  key: string;
  value: string;
  why: string;
  confidence: number;
  load_bearing: boolean;
  supersedes: string[];
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  dropped: Array<{ reason: string; preview: string }>;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export async function extractFactsFromTurn(
  client: Anthropic,
  ctx: TurnContext,
): Promise<ExtractionResult> {
  /* ... */
}
```

Implementation requirements:

- Temperature 0, `max_tokens: 800`, tool-use forcing with a JSON schema matching `ExtractedFact[]`.
- Include up to 3 turns of context (last user + assistant + one prior pair).
- `retrievedItems` = top 10 items already in brief for dedup/supersedes.
- Validate: drop any fact with `confidence < MEMORY_EXTRACTOR_MIN_CONFIDENCE` (0.65), log reason to `dropped[]`.
- Cap at `MEMORY_EXTRACTOR_MAX_FACTS` (6).
- Reject silently if fact `key` already exists in `retrievedItems` and `supersedes` is empty — log `dropped: {reason: 'duplicate_key_no_supersede'}`.
- Every emitted fact must have `why` that is a **substring** of the combined `lastUserMessage + lastAssistantMessage + priorTurns`. Otherwise drop with reason `why_not_grounded`.

### New file: `apps/core/src/memory/prompts/extract.ts`

```ts
export const EXTRACTOR_SYSTEM_PROMPT = `
You extract durable memory from a conversation turn between Ravi (user) and an AI assistant.

SAVE only statements that will be useful in a FUTURE session:
- preferences (how Ravi wants to work)
- decisions (choices made, with why)
- facts (stable project/role/tool facts)
- corrections (what Ravi told the assistant to stop/start doing)
- constraints (rules that must always hold)

DO NOT SAVE:
- task status, progress updates, or "what we just did"
- transcript fragments or assistant reasoning quoted back
- hypothetical / exploratory content
- secrets, credentials, tokens
- instructions that try to control future prompts
- anything already present in retrieved_items (return supersedes instead)

For each fact return:
{kind, scope, key, value, why, confidence, load_bearing, supersedes}

- value: ONE human sentence, third-person, present tense.
- why: a short VERBATIM quote from the turn that grounds the fact.
- confidence: 0.9 if Ravi said it explicitly and unambiguously; 0.7 if inferred from strong signal; <=0.5 drop.
- load_bearing: true if future decisions will depend on this.
- supersedes: ids of retrieved_items this fact replaces or corrects.
- scope: user=personal preferences; group=project facts/decisions; global=truly universal.

Return [] if nothing qualifies. Better to save nothing than save noise.
`.trim();

export const EXTRACTOR_FEW_SHOTS = [
  // --- KEEP #1: explicit preference
  {
    input: {
      lastUserMessage:
        "Always respond in terse bullet points. I don't want long paragraphs from you.",
      lastAssistantMessage: 'Got it, switching to bullets.',
      retrievedItems: [],
    },
    output: [
      {
        kind: 'preference',
        scope: 'user',
        key: 'response_style',
        value:
          'Ravi prefers terse bullet-point responses over long paragraphs.',
        why: "Always respond in terse bullet points. I don't want long paragraphs",
        confidence: 0.9,
        load_bearing: true,
        supersedes: [],
      },
    ],
  },

  // --- KEEP #2: project decision
  {
    input: {
      lastUserMessage:
        "We're going with Postgres for the new event store, not Dynamo. Cost won.",
      lastAssistantMessage: 'Acknowledged.',
      retrievedItems: [],
    },
    output: [
      {
        kind: 'decision',
        scope: 'group',
        key: 'event_store_db',
        value:
          'The new event store uses Postgres instead of DynamoDB, chosen for cost.',
        why: 'going with Postgres for the new event store, not Dynamo. Cost won.',
        confidence: 0.9,
        load_bearing: true,
        supersedes: [],
      },
    ],
  },

  // --- KEEP #3: correction superseding an existing item
  {
    input: {
      lastUserMessage:
        'Actually, my timezone moved to UTC+5:30 IST last month, not UTC-5.',
      lastAssistantMessage: 'Updating.',
      retrievedItems: [
        {
          id: 'mem-123',
          key: 'user_timezone',
          value: 'Ravi works in UTC-5 Eastern time.',
        },
      ],
    },
    output: [
      {
        kind: 'correction',
        scope: 'user',
        key: 'user_timezone',
        value: 'Ravi works in IST (UTC+5:30) as of last month.',
        why: 'my timezone moved to UTC+5:30 IST last month, not UTC-5',
        confidence: 0.9,
        load_bearing: true,
        supersedes: ['mem-123'],
      },
    ],
  },

  // --- REJECT #1: task status / ephemeral
  {
    input: {
      lastUserMessage: 'Did you finish the migration script?',
      lastAssistantMessage: 'Yes, pushed it to the branch.',
      retrievedItems: [],
    },
    output: [],
  },

  // --- REJECT #2: transcript fragment masquerading as procedure
  {
    input: {
      lastUserMessage: 'How does the permission flow work?',
      lastAssistantMessage:
        'Found it. The gate is in apps/core/src/session/session-commands.ts:126-131 and checks isFromMe || isSenderControlAllowlisted.',
      retrievedItems: [],
    },
    output: [],
  },

  // --- REJECT #3: hypothetical
  {
    input: {
      lastUserMessage:
        "If we ever switch to gRPC, we'd probably want to move auth into interceptors.",
      lastAssistantMessage: 'Makes sense.',
      retrievedItems: [],
    },
    output: [],
  },
];
```

Shots ship as typed constants; the extractor formats them into the user/assistant turn structure Anthropic expects.

### Write-time behavior

1. **Dedup by key**: lowercased `(scope, group_folder, key)` match → call `memory_patch` instead of insert. Bump `version`, update `value`, append prior value into a short history in `why` (last 3).
2. **Supersede**: for every id in `fact.supersedes`, set `is_deleted=1`, `deleted_at=now`, `superseded_by=<new_id>`; delete QMD mirror.
3. **Procedure channel**: extractor never emits procedures. Procedures only via:
   - `/save-procedure "<title>"` chat command (new — §14).
   - `mcp__myclaw__procedure_save` MCP tool (existing).

### Acceptance

- Eval harness (§13) reports precision ≥0.85, recall ≥0.7 on golden set.
- Journal emits `extraction_completed` per §11.
- No procedure with title starting `"Found it"`, `"Findings"`, `"Critical"`, `"End-to-end"`, `"No answer"`, `"Three full"`, `"On it"` gets created. Add a regex guard in `/save-procedure` to reject these.

---

## 4. Session pipeline — continuation

### Hook wiring

**File**: `/Users/ravikiranvemula/myclaw/.claude/settings.json` — generated by MyClaw as an exact runtime settings file.

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "0"
  },
  "autoMemoryEnabled": false,
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|compact",
        "hooks": [
          {
            "type": "command",
            "command": "npx --yes myclaw@<installed-version> memory-hook load",
            "timeout": 10
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "npx --yes myclaw@<installed-version> memory-hook extract --trigger=precompact",
            "timeout": 120,
            "async": true
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "clear|resume|logout|other",
        "hooks": [
          {
            "type": "command",
            "command": "npx --yes myclaw@<installed-version> memory-hook extract --trigger=session-end",
            "timeout": 120,
            "async": true
          }
        ]
      }
    ]
  }
}
```

The `myclaw memory-hook` CLI reads Claude hook stdin, resolves the runtime group, and runs the configured memory load or extraction path.

### Archive action

Edit `apps/core/src/session/session-transcript-archive.ts`:

1. Read transcript JSONL at the standard Claude Code location.
2. Call Sonnet 4.6 with **Summary prompt** below.
3. Write output to `/Users/ravikiranvemula/myclaw/agent-memory/sessions/YYYY/MM/DD/HHMMSS-{cause}-{slug}.md`.
4. Frontmatter:
   ```yaml
   ---
   session_id: <uuid>
   cause: session-start | pre-compact | session-stop | manual-compact | new-session
   archived_at: <ISO8601>
   turn_count: <int>
   group_folder: telegram_kai-dev
   model: claude-sonnet-4-6
   ---
   ```
5. Then call `MemoryService.reflectAfterTurn()` on the last 3 turns of the transcript to catch durable facts missed turn-by-turn.

Remove the silent early-return bugs noted in the critique:

- L282–287, L314–319: log the skip reason as an event, don't silently null.

### Summary prompt (verbatim)

```
Summarize this Claude Code session for future continuation.

Produce STRICT markdown with exactly these four sections in this order:

## Summary
<= 200 words, past tense, what was done and decided.

## Open loops
- bullet list of unresolved asks, blocked items, or "come back to this" commits.
- empty bullet `- none` if nothing unresolved.

## Decisions
- bullet list of non-obvious choices with their rationale.
- `- none` if no decisions this session.

## Files touched
- path — one-line change summary.
- `- none` if no files changed.

Do NOT include:
- ephemeral chatter, acknowledgements, or tool-output dumps
- speculation about what the user might want next
- marketing language or praise
- content that does not appear in the transcript

Quote file paths, identifiers, and decisions verbatim from the transcript. Never invent file paths or function names.
```

### Continuity brief upgrade

Edit `buildMemoryContext()` in `apps/core/src/memory/memory-service.ts` (around `:538`):

1. Add `lastSessionBlock`: read the most recent `sessions/YYYY/MM/DD/*.md` file for the current `group_folder` (sort by filename desc). Extract `## Summary` and `## Open loops` sections verbatim.
2. Include the block at the top of the injected brief if any of:
   - User prompt matches `/\b(continue|resume|pick up|last session)\b/i`
   - This is the first user turn of a fresh session (`turn_index === 0`)
3. **Brief refresh**: add a `dirty: boolean` flag on the brief cache. Set `dirty=true` from `memory_save` / `memory_patch` / `procedure_save`. Rebuild on next `buildMemoryContext()` call. Currently the brief is stale for the whole session.

### Acceptance

- After any `SessionStart`, `PreCompact`, or `Stop` hook, a `.md` file appears in `agent-memory/sessions/YYYY/MM/DD/`.
- Fresh session with the word "continue" includes the prior `## Summary` block verbatim in the first brief.
- Saving a memory mid-session makes the next turn's brief reflect it without requiring `/new`.

---

## 5. Nightly pipeline — dreaming

### Schedule

Cron `0 3 * * *` IST. Already registered at `apps/core/src/runtime/task-scheduler.ts:340-376`. Flip `settings.yaml -> memory.dreaming.enabled=true` (§12).

### Stage A — statistical pre-rank (keep, do not rewrite)

Keep the formula in `apps/core/src/memory/memory-dreaming.ts:177-216`:

```
score = 0.24 * frequency + 0.30 * relevance + 0.15 * diversity + 0.15 * recency + 0.10 * consolidation + 0.06 * confidence
```

Bucket each item:

- `promote_candidate`: score ≥ `MEMORY_DREAMING_PROMOTION_THRESHOLD` (0.55)
- `decay_candidate`: score ≤ `MEMORY_DREAMING_DECAY_THRESHOLD` (0.15)
- `review_candidate`: everything else, top 50 by `abs(score - 0.35)` (items closest to ambiguous middle).

**Stage A writes nothing.** It only produces a candidate list.

### Stage B — LLM review (NEW)

Take up to 30 items/run (mix of all three buckets), call Sonnet 4.6.

### Dream review prompt (verbatim)

```
You are pruning and consolidating a memory store for Ravi.

INPUTS: a list of memory items. Each item has:
  id, kind, value, why, confidence, retrieval_count, last_used_at, age_days, pre_rank_signal

For each item output EXACTLY ONE action:
- keep        — item is correct and distinct; no change needed
- rewrite     — item is correct but poorly worded; return rewritten value
- merge_into  — item is a duplicate or subset of another input item; return target id (must be in input set)
- retire      — item is stale, contradicted, or never useful

RULES
- Never invent facts absent from the inputs. Your output may only contain text that appears verbatim in the input items, minus articles and filler.
- Preserve verbatim: names, identifiers, file paths, numbers, dates.
- Prefer merge over retire when content overlaps.
- Explain each decision in <= 15 words.
- Output strict JSON: [{id, action, target_id?, rewritten_value?, reason}]. No prose outside the JSON.
```

### Dream review few-shots (verbatim)

```ts
export const DREAM_REVIEW_FEW_SHOTS = [
  // --- merge duplicates
  {
    inputs: [
      {
        id: 'a',
        kind: 'preference',
        value: 'Ravi prefers terse responses.',
        why: 'quick and terse',
        confidence: 0.8,
        retrieval_count: 12,
        last_used_at: '2026-04-10',
        age_days: 30,
        pre_rank_signal: 'keep',
      },
      {
        id: 'b',
        kind: 'preference',
        value: 'Ravi likes short answers.',
        why: 'short answers please',
        confidence: 0.7,
        retrieval_count: 3,
        last_used_at: '2026-03-01',
        age_days: 60,
        pre_rank_signal: 'review',
      },
    ],
    output: [
      {
        id: 'a',
        action: 'keep',
        reason: 'canonical preference, high retrieval.',
      },
      {
        id: 'b',
        action: 'merge_into',
        target_id: 'a',
        reason: 'duplicate of a with lower retrieval.',
      },
    ],
  },

  // --- rewrite for clarity
  {
    inputs: [
      {
        id: 'c',
        kind: 'fact',
        value: 'user works at kl (hyd)',
        why: 'VP Eng KnackLabs Hyderabad',
        confidence: 0.75,
        retrieval_count: 5,
        last_used_at: '2026-04-15',
        age_days: 90,
        pre_rank_signal: 'keep',
      },
    ],
    output: [
      {
        id: 'c',
        action: 'rewrite',
        rewritten_value:
          'Ravi is VP Engineering at KnackLabs, based in Hyderabad.',
        reason: 'existing value is garbled; facts recoverable from why.',
      },
    ],
  },

  // --- retire stale
  {
    inputs: [
      {
        id: 'd',
        kind: 'decision',
        value: 'Sprint 42 scope locked to auth refactor only.',
        why: 'locking sprint 42',
        confidence: 0.6,
        retrieval_count: 0,
        last_used_at: null,
        age_days: 120,
        pre_rank_signal: 'decay',
      },
    ],
    output: [
      {
        id: 'd',
        action: 'retire',
        reason: 'sprint-specific, expired, never retrieved.',
      },
    ],
  },

  // --- never invent (reject the temptation)
  {
    inputs: [
      {
        id: 'e',
        kind: 'fact',
        value: 'Postgres is the event store DB.',
        why: 'going with Postgres for the new event store',
        confidence: 0.9,
        retrieval_count: 2,
        last_used_at: '2026-04-18',
        age_days: 1,
        pre_rank_signal: 'keep',
      },
    ],
    output: [
      {
        id: 'e',
        action: 'keep',
        reason: 'explicit recent decision, grounded in why.',
      },
      // NOTE: do NOT invent a second fact about connection pooling or anything not in inputs.
    ],
  },
];
```

### Apply decisions

- `keep`: `confidence = min(1.0, confidence + MEMORY_DREAMING_CONFIDENCE_BOOST)` (0.05); set `last_reviewed_at=now`.
- `rewrite`: update `value` to `rewritten_value`; append `reason` to `why` with prefix `[dream-rewrite]`; bump `version`; set `last_reviewed_at=now`.
- `merge_into`: soft-delete item `id` (`is_deleted=1`, `deleted_at=now`, `superseded_by=target_id`); delete QMD mirror; update `target_id`'s `retrieval_count += id.retrieval_count` (absorb).
- `retire`: soft-delete; delete QMD mirror.

### Post-hoc grounding check (anti-hallucination)

Before applying any `rewrite` or `merge_into`:

- Extract all identifiers from output (names, paths like `apps/...`, numbers, IDs like `mem-xxx`) via regex.
- Assert every identifier is present in the input set for that review batch.
- On failure: drop the decision, log telemetry `dream_hallucination_rejected` with the offending token.

### Consolidation prompt (replace stub at `memory-consolidation.ts:255-263`)

```
Merge these duplicate memory facts into ONE canonical fact.

RULES
- The output value may only contain information present in the INPUT facts. Do not add context, examples, or implications.
- If inputs disagree, prefer the highest-confidence fact OR the most recent `updated_at`; note the conflict briefly in `why`.
- Produce exactly ONE human sentence, third-person, present tense.
- Preserve verbatim: names, identifiers, file paths, numbers, dates.

OUTPUT strict JSON: {key, value, why, confidence, retired_ids}
- key: slug, lowercased, max 40 chars.
- retired_ids: the ids of ALL input facts that are being merged away (all inputs, since they are collapsing into one).
- confidence: max(input confidences) rounded to 2 decimals.
```

### Consolidation few-shots (verbatim)

```ts
export const CONSOLIDATION_FEW_SHOTS = [
  // --- clean dedup
  {
    inputs: [
      {
        id: 'x',
        key: 'response_style',
        value: 'Ravi prefers terse bullet-point responses.',
        confidence: 0.88,
        updated_at: '2026-04-15',
      },
      {
        id: 'y',
        key: 'response_style_preference',
        value: 'Ravi likes short, direct answers with bullets.',
        confidence: 0.8,
        updated_at: '2026-03-30',
      },
    ],
    output: {
      key: 'response_style',
      value: 'Ravi prefers terse, direct, bullet-point responses.',
      why: 'Merged two overlapping preferences; preferred higher-confidence recent fact.',
      confidence: 0.88,
      retired_ids: ['x', 'y'],
    },
  },

  // --- conflict resolution by recency
  {
    inputs: [
      {
        id: 'p',
        key: 'event_store_db',
        value: 'Event store uses DynamoDB.',
        confidence: 0.85,
        updated_at: '2026-02-10',
      },
      {
        id: 'q',
        key: 'event_store_db',
        value:
          'The new event store uses Postgres instead of DynamoDB, chosen for cost.',
        confidence: 0.9,
        updated_at: '2026-04-18',
      },
    ],
    output: {
      key: 'event_store_db',
      value:
        'The event store uses Postgres (switched from DynamoDB on 2026-04-18, chosen for cost).',
      why: 'Conflict resolved by recency; q (2026-04-18) supersedes p (2026-02-10).',
      confidence: 0.9,
      retired_ids: ['p', 'q'],
    },
  },

  // --- preserve verbatim identifiers
  {
    inputs: [
      {
        id: 'r',
        key: 'permission_gate',
        value: 'Permission check lives in session-commands.ts.',
        confidence: 0.75,
        updated_at: '2026-04-01',
      },
      {
        id: 's',
        key: 'permission_gate_location',
        value:
          'isSessionCommandAllowed at apps/core/src/session/session-commands.ts:126-131.',
        confidence: 0.85,
        updated_at: '2026-04-05',
      },
    ],
    output: {
      key: 'permission_gate',
      value:
        'Permission check lives in apps/core/src/session/session-commands.ts:126-131 in isSessionCommandAllowed.',
      why: 'Merged to retain exact file path and line numbers from s.',
      confidence: 0.85,
      retired_ids: ['r', 's'],
    },
  },

  // --- attribute preservation
  {
    inputs: [
      {
        id: 't',
        key: 'user_role',
        value: 'Ravi is VP Engineering.',
        confidence: 0.8,
        updated_at: '2026-01-01',
      },
      {
        id: 'u',
        key: 'user_employer',
        value: 'Ravi works at KnackLabs in Hyderabad.',
        confidence: 0.85,
        updated_at: '2026-02-20',
      },
    ],
    output: {
      key: 'user_role',
      value: 'Ravi is VP Engineering at KnackLabs, based in Hyderabad.',
      why: 'Merged role and employer/location facts.',
      confidence: 0.85,
      retired_ids: ['t', 'u'],
    },
  },
];

export const CONSOLIDATION_REJECTION_SHOTS = [
  // --- rejection #1: hallucinated context
  {
    inputs: [
      {
        id: 'h1',
        key: 'db_choice',
        value: 'Event store uses Postgres.',
        confidence: 0.9,
        updated_at: '2026-04-18',
      },
    ],
    bad_output: {
      key: 'db_choice',
      value:
        'Event store uses Postgres with PgBouncer connection pooling and read replicas.',
      why: 'Added operational detail.',
      confidence: 0.9,
      retired_ids: ['h1'],
    },
    why_rejected:
      'PgBouncer and read replicas are not in the inputs. Hallucinated.',
  },

  // --- rejection #2: invented identifier
  {
    inputs: [
      {
        id: 'h2',
        key: 'permission_gate',
        value: 'Permission check lives in session-commands.ts.',
        confidence: 0.75,
        updated_at: '2026-04-01',
      },
    ],
    bad_output: {
      key: 'permission_gate',
      value:
        'Permission check lives in apps/core/src/session/session-commands.ts:126-131.',
      why: 'Specified path and lines.',
      confidence: 0.75,
      retired_ids: ['h2'],
    },
    why_rejected:
      'Input only says "session-commands.ts". Full path and line numbers were invented.',
  },
];
```

### Consolidation fallback without embeddings

Current code requires embeddings. If `EmbeddingProvider` disabled or fails:

- Cluster by lowercased `key` prefix match (>=3 leading tokens) OR Jaccard similarity on token sets of `value` (≥0.6 threshold).
- Max 50 clusters per run; at least 2 items per cluster.
- Proceed to LLM merge using the same prompt.

### Post-hoc grounding check

Same as §5 Stage B: every identifier (paths, IDs, names) in the merged `value` must appear in at least one input's `value` or `why`. Otherwise reject and fall back to "pick highest-confidence input verbatim".

### Manual trigger

Add `/dream` chat command (§14) — runs the full sweep (stage A + B + consolidation) on demand, on whichever `group_folder` the chat belongs to.

### Acceptance

- Journal emits `dream_started` and `dream_completed` per §11 every run.
- `/dream` returns within 60s for up to 200 items.
- 10-cluster consolidation eval: zero hallucinated tokens in merged outputs.
- `dream_hallucination_rejected` count is part of `/memory-status` output.

---

## 6. Cleanup + observability

### Nightly cleanup job (new, scheduled `0 4 * * *` IST — after dream)

1. **Orphan QMD sweep**:
   - For every `profile/*.md` and `procedures/*.md`, verify a corresponding DB row exists and `is_deleted=0`. Delete the file otherwise.
   - Log `{swept: N, errors: M}` as `cleanup_mirror_completed`.
2. **Hard purge**:
   - `DELETE FROM memory_items WHERE is_deleted=1 AND deleted_at < datetime('now', '-30 days');`
   - Same for `memory_procedures`.
   - Log `cleanup_purge_completed {items: N, procedures: M}`.
3. **Journal rotation**:
   - `journal/YYYY/MM/YYYY-MM-DD.md` files older than 7 days → gzip.
   - Gzipped files older than 90 days → delete.
   - Log `cleanup_journal_rotated {gzipped: N, deleted: M}`.
4. **Session summary rotation**:
   - `sessions/YYYY/MM/DD/*.md` older than 90 days → gzip.
   - Never delete summaries (they're cheap and valuable for long-term continuity).

### Telemetry events (append to existing journal)

Existing pattern: markdown sections `## <ISO8601> - <event-name>` with key-value lines. Keep that style.

See §11 for the full event catalog.

---

## 7. Known-bug fixes bundled in Phase 0

These are not part of the redesign but MUST ship alongside it.

### 7.1 IPC lock PID liveness

File: `apps/core/src/runtime/ipc.ts` (around `:224`, function `acquireIpcRootLock`).

Pseudo-fix:

```ts
function acquireIpcRootLock(lockPath: string): boolean {
  try {
    // try exclusive create
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      { flag: 'wx' },
    );
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // existing holder — check liveness
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const parsed = JSON.parse(raw) as { pid?: number; startedAt?: string };
      if (typeof parsed.pid === 'number') {
        try {
          process.kill(parsed.pid, 0); // throws ESRCH if dead
          return false; // alive — cannot acquire
        } catch (killErr) {
          if ((killErr as NodeJS.ErrnoException).code === 'ESRCH') {
            // holder is dead — steal the lock
            fs.writeFileSync(
              lockPath,
              JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString(),
              }),
            );
            logWarn('ipc.lock.stolen', {
              staleHolder: parsed.pid,
              staleStartedAt: parsed.startedAt,
            });
            return true;
          }
          throw killErr;
        }
      }
      return false;
    } catch (readErr) {
      // corrupted lock file — overwrite
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      );
      return true;
    }
  }
}
```

Also: bump the "IPC watcher lock already held, skipping start" log from DEBUG to WARN and include the stale holder PID and age.

### 7.2 Procedure garbage purge (one-shot)

Before cutover, hard-delete existing procedures whose titles match:

```
^(Found it|Findings|Critical|End-to-end|No answer|Three full|On it|##|\*\*)
```

Run as a one-shot script, archived under `scripts/one-shot/purge-procedure-fragments.ts`.

### 7.3 Consolidation scope counter

Diagnose the `min_items_not_reached:50` bug at `memory-consolidation.ts:44-59`. Suspect: `listActiveItems(groupFolder, 10_000)` — group-scoped filter returns fewer than global count. Fix: either (a) iterate all groups, or (b) also consolidate across `user` and `global` scopes in separate passes.

---

## 8. Phased rollout

| Phase                 | Work                                                                                                                                                                                                                                                          | Gate                                                                                                                                                  | Risk          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| **0. Stabilize**      | IPC lock fix (§7.1), purge procedure fragments (§7.2), diagnose consolidation counter (§7.3), enable dream+consolidation flags (§12), emit dream telemetry (§11)                                                                                              | `/dream` runs manually end-to-end with telemetry.                                                                                                     | Low           |
| **1. Cutover prep**   | Tar backup `agent-memory/`. Implement `extractor-llm.ts` + prompts + few-shots behind default fallback behavior (no feature flag). Shadow-log: run both old regex and new LLM extractors for 24h, diff outputs into a journal event `extraction_shadow_diff`. | Shadow diff reviewed by Ravi; looks sane.                                                                                                             | Low           |
| **2. Cutover**        | Tar backup again. Stop runtime. Wipe `memory.db` + `profile/` + `procedures/`. Apply v4 schema. Promote LLM extractor to default path. Remove old regex extractor call path (keep file for unit tests only). Restart.                                         | After 24h of normal use: <10 items total, zero procedure-fragment titles, zero hallucination-rejected extractions.                                    | Medium        |
| **3. Sessions**       | Generate runtime `.claude/settings.json` with `myclaw memory-hook` commands. Implement Sonnet session-summary prompt. Update `buildMemoryContext`.                                                                                                            | New session with prompt "continue" sees prior `## Summary` in the brief; a .md file exists under `sessions/YYYY/MM/DD/` after every session boundary. | Medium        |
| **4. Dreaming v2**    | Implement stage B LLM review. Replace consolidation prompt + few-shots. Add embedding-less fallback clustering. Wire `/dream` command. Dry-run mode for first 3 nights (log decisions but do not apply).                                                      | Dry-run log reviewed; then flip to live.                                                                                                              | Low (nightly) |
| **5. Cleanup + eval** | Nightly cleanup job (§6). Eval harness in CI. `/memory-status` command.                                                                                                                                                                                       | CI green on golden set; `/memory-status` returns sane numbers.                                                                                        | Low           |

---

## 9. Files to touch

### New files

- `apps/core/src/memory/extractor-llm.ts`
- `apps/core/src/memory/prompts/extract.ts`
- `apps/core/src/memory/prompts/dream.ts`
- `apps/core/src/memory/prompts/consolidate.ts`
- `apps/core/src/memory/prompts/session-summary.ts`
- `apps/core/src/memory/cleanup-job.ts`
- `apps/core/src/memory/grounding-check.ts` (identifier-in-input assertion)
- `apps/core/src/session/session-commands/dream.ts`
- `apps/core/src/session/session-commands/memory-status.ts`
- `apps/core/src/session/session-commands/save-procedure.ts`
- `apps/core/test/memory-eval/golden.json`
- `apps/core/test/memory-eval/runner.ts`
- `scripts/one-shot/purge-procedure-fragments.ts`
- `apps/core/src/cli/memory-hook.ts` — hook CLI

### Edited files

- `apps/core/src/memory/memory-types.ts` — drop `'context'` and `'recent_work'` from `MemoryKind`, add new fields to `MemoryItem` and `MemoryProcedure`.
- `apps/core/src/memory/memory-store.ts` — `SCHEMA_VERSION=4`, `migrateToV4()`, `deleteMirror()` hooks in soft-delete paths.
- `apps/core/src/memory/memory-service.ts` — `reflectAfterTurn` swaps regex extractor for `extractor-llm`; `buildMemoryContext` adds `## Last session`, dirty-cache refresh.
- `apps/core/src/memory/memory-provider.ts` — `mirrorMemoryItem` + inverse `unmirrorMemoryItem`.
- `apps/core/src/memory/memory-consolidation.ts` — new prompt, few-shots, embedding-less fallback, grounding check.
- `apps/core/src/memory/memory-dreaming.ts` — add Stage B LLM review after the existing Stage A math, hallucination rejection, telemetry.
- `apps/core/src/memory/memory-ipc.ts` — add `/memory-status`, `/dream`, `/save-procedure` handlers.
- `apps/core/src/session/session-transcript-archive.ts` — Sonnet summary, remove silent early returns, add telemetry for skip paths.
- `apps/core/src/session/session-commands.ts` — register new commands.
- `apps/core/src/runtime/task-scheduler.ts` — register cleanup job, ensure dream telemetry is emitted, validate `linked_sessions` wiring.
- `apps/core/src/runtime/ipc.ts` — §7.1 PID liveness fix.
- `apps/core/src/core/config.ts` — new flags (§12).
- `/Users/ravikiranvemula/myclaw/.claude/settings.json` — hooks (§4).

---

## 10. Commands

Three new chat commands. Add to `session-commands.ts`.

### `/dream`

- Auth: `isFromMe || isSenderControlAllowlisted`.
- Action: runs full dream sweep (A + B + consolidation) on current group.
- Response: `Dream complete: promoted=N, rewritten=M, merged=K, retired=L, rejected_hallucinations=H, took Xs.`

### `/memory-status`

- Auth: `isFromMe || isSenderControlAllowlisted`.
- Response: a structured block with:
  - Items by kind (all scopes).
  - Top 10 most-used items (value + retrieval_count).
  - Top 10 stalest items (value + last_used_at).
  - Last dream run timestamp + stats.
  - Disk usage: `profile/`, `procedures/`, `sessions/`, `journal/` in KB.

### `/save-procedure`

- Auth: `isFromMe || isSenderControlAllowlisted`.
- Syntax: `/save-procedure "<title>"\n<steps markdown>`.
- Validation:
  - Title 10–80 chars.
  - Title MUST NOT match forbidden prefixes regex (§7.2).
  - Body MUST contain at least 2 numbered steps.
  - Rejects if body is verbatim identical to any assistant message in the last 5 turns (prevents accidental "save my last reply" abuse).
- Writes with `origin: 'explicit'`.

---

## 11. Telemetry event catalog

Append to `/Users/ravikiranvemula/myclaw/agent-memory/journal/YYYY/MM/YYYY-MM-DD.md` using the existing `## <ISO8601> - <event-name>` markdown format with key-value payload lines.

### Extraction

- `extraction_skipped_prefilter { group, turn_id, reason }`
- `extraction_completed { group, turn_id, extracted, saved, patched, superseded, dropped, model, input_tokens, output_tokens, took_ms }`
- `extraction_error { group, turn_id, error }`

### Session

- `session_archive_started { group, session_id, cause }`
- `session_archive_completed { group, session_id, cause, turn_count, summary_path, took_ms }`
- `session_archive_skipped { group, session_id, cause, reason }` — was silent null; now explicit.

### Dream

- `dream_scheduled { group, cron, next_fire_at }` — emitted at startup for visibility.
- `dream_started { group, candidates_a, promote_n, decay_n, review_n }`
- `dream_completed { group, promoted, rewritten, merged, retired, rejected_hallucinations, took_ms }`
- `dream_hallucination_rejected { group, item_id, offending_token, source: 'review' | 'consolidation' }`
- `dream_failed { group, error, took_ms }`

### Consolidation

- `consolidation_started { group, clusters }`
- `consolidation_completed { group, merged_items, retired_items, mode: 'llm' | 'heuristic' | 'none', skipped_reason? }`

### Cleanup

- `cleanup_mirror_completed { swept, errors }`
- `cleanup_purge_completed { items, procedures }`
- `cleanup_journal_rotated { gzipped, deleted }`

### IPC

- `ipc.lock.stolen { staleHolder, staleStartedAt }` — from §7.1.

---

## 12. Config flags (add to `apps/core/src/core/config.ts`)

| Env var                                              | Default                             | Purpose                                                                       |
| ---------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `settings.yaml -> memory.llm.models.extractor`       | `claude-haiku-4-5-20251001`         | Model ID for extraction (falls back to `ANTHROPIC_MODEL`, then hard default). |
| `MEMORY_EXTRACTOR_MAX_FACTS`                         | `6`                                 | Per-turn cap.                                                                 |
| `MEMORY_EXTRACTOR_MIN_CONFIDENCE`                    | `0.65`                              | Drop below this.                                                              |
| `settings.yaml -> memory.dreaming.enabled`           | `true`                              | Flip from existing `false`.                                                   |
| `settings.yaml -> memory.llm.models.dreaming`        | `claude-sonnet-4-6`                 | Stage B model.                                                                |
| `MEMORY_DREAMING_DRY_RUN`                            | `true` (first 3 runs), then `false` | Log decisions without applying.                                               |
| `MEMORY_DREAMING_PROMOTION_THRESHOLD`                | `0.55`                              | Keep existing default.                                                        |
| `MEMORY_DREAMING_DECAY_THRESHOLD`                    | `0.15`                              | Keep existing default.                                                        |
| `MEMORY_DREAMING_CONFIDENCE_BOOST`                   | `0.05`                              | Keep existing default.                                                        |
| `MEMORY_DREAMING_CONFIDENCE_DECAY`                   | `0.03`                              | Keep existing default.                                                        |
| `consolidation stage`                                | always-on                           | Runs as an internal step whenever memory is enabled.                          |
| `settings.yaml -> memory.llm.models.consolidation`   | `claude-sonnet-4-6`                 | Consolidation model.                                                          |
| `MEMORY_CONSOLIDATION_MIN_ITEMS`                     | `20`                                | Lowered from 50.                                                              |
| `MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK`            | `true`                              | Allow lexical clustering without embeddings.                                  |
| `settings.yaml -> memory.llm.models.session_summary` | `claude-sonnet-4-6`                 | Session summary model.                                                        |
| `MEMORY_CLEANUP_PURGE_DAYS`                          | `30`                                | Hard-delete threshold.                                                        |
| `MEMORY_JOURNAL_GZIP_DAYS`                           | `7`                                 | Journal gzip age.                                                             |
| `MEMORY_JOURNAL_DELETE_DAYS`                         | `90`                                | Journal delete age.                                                           |
| `MEMORY_BRIEF_INCLUDE_LAST_SESSION`                  | `true`                              | Toggle `## Last session` block in brief.                                      |
| `MEMORY_BRIEF_DIRTY_REFRESH`                         | `true`                              | Rebuild brief after any memory write.                                         |

All flags documented in `apps/core/src/core/config.ts` with JSDoc strings. Default values above are the shipped values after Phase 2.

---

## 13. Eval harness

**Location**: `apps/core/test/memory-eval/`

### `golden.json`

20-turn conversation, hand-authored. Mix of:

- 6 turns that should produce facts (3 preferences, 2 decisions, 1 correction).
- 3 turns that should produce a fact superseding an existing retrieved item.
- 11 turns that should produce NOTHING (task chatter, hypotheticals, tool output quotes, questions, acknowledgements, etc.).

Each turn carries `expected_facts: ExtractedFact[]` (empty if none expected).

### `runner.ts`

- Loads the golden conversation.
- For each turn, builds `TurnContext` and calls `extractFactsFromTurn` with a real Anthropic client (or a mock in `CI=true` mode using captured LLM responses).
- Compares extracted facts to expected facts:
  - **Match**: `kind + scope + key` match. (Value wording can differ; verify substring of expected value's key noun.)
  - **Precision** = matched / total_extracted.
  - **Recall** = matched / total_expected.
- Fails the test if precision < 0.85 or recall < 0.70 (configurable thresholds).

### CI

Add a new script in `package.json`: `"test:memory-eval": "vitest run --config vitest.integration.config.ts apps/core/test/memory-eval"`. Gate this in CI on changes to `apps/core/src/memory/**`.

### Consolidation eval

Second fixture `consolidation-golden.json` with 10 duplicate clusters and expected merged outputs. The grounding-check logic (§5) is validated here: any merged output containing a token not in the cluster's inputs fails the test.

---

## 14. Cutover steps (executable)

Run these in order. Stop if any step fails; do not proceed without confirming with Ravi.

```
# 1. Backup
tar -czf ~/myclaw-backup-$(date +%Y%m%d-%H%M%S).tgz -C /Users/ravikiranvemula/myclaw agent-memory data

# 2. Stop runtime (user-specific; confirm command with Ravi)

# 3. Apply Phase 0 fixes (IPC lock, telemetry, flag defaults) and deploy

# 4. Confirm /dream works in Phase 0 — manual invocation, telemetry visible in journal

# 5. Phase 1: implement extractor-llm; enable shadow logging (run both paths)

# 6. Review 24h of shadow diffs; resolve prompt issues

# 7. Phase 2 cutover:
#    a. Second backup.
#    b. Stop runtime.
#    c. rm /Users/ravikiranvemula/myclaw/agent-memory/.cache/memory.db
#    d. rm -rf /Users/ravikiranvemula/myclaw/agent-memory/profile/* /Users/ravikiranvemula/myclaw/agent-memory/procedures/*
#    e. Promote extractor-llm as the default path
#    f. Restart runtime; schema migration to v4 runs on first DB open.

# 8. 24h observation. Abort to backup if critical failures.

# 9. Phase 3: add Claude Code hooks, ship session archiver CLI.

# 10. Phase 4: enable dream v2 in dry-run mode for 3 nights, review, then flip live.

# 11. Phase 5: enable cleanup job, add /memory-status, ship eval harness in CI.
```

---

## 15. Acceptance tests (final gate before "done")

- [ ] `sqlite3 agent-memory/.cache/memory.db ".schema memory_items"` shows v4 columns: `why`, `load_bearing`, `source_turn_id`, `used_count`, `superseded_by`, `is_deleted`, `deleted_at`, `last_reviewed_at`.
- [ ] `SELECT COUNT(*) FROM memory_procedures WHERE title LIKE 'Found it%' OR title LIKE 'Findings%' OR title LIKE 'Critical%';` returns 0.
- [ ] `ls agent-memory/sessions/YYYY/MM/DD/` contains a `.md` after any new session or `/compact`.
- [ ] A fresh session started with the word "continue" shows `## Last session` block in the first brief injection.
- [ ] `/dream` returns within 60s and logs `dream_completed` with non-null stats.
- [ ] `/memory-status` returns structured output with all §14 fields.
- [ ] After 24h of use post-cutover: no memory item `value` contains code fence backticks or markdown lists (signal of transcript fragment contamination).
- [ ] `dream_hallucination_rejected` count in last 7 days ≤ 2% of total review decisions.
- [ ] Eval harness `test:memory-eval` passes: precision ≥0.85, recall ≥0.7.
- [ ] Consolidation eval `test:memory-eval:consolidation` passes: 0 hallucinated tokens in merged outputs.
- [ ] No `profile/*.md` or `procedures/*.md` files exist whose id is `is_deleted=1` in DB.
- [ ] Stale IPC lock test: kill process holding the lock, verify next watcher steals it within one poll cycle and logs `ipc.lock.stolen`.

---

## 16. Open decisions still owned by Ravi

1. **Cutover confirmed**: wipe DB + QMD mirrors, no migration of existing 163 items. (Default; confirm before Phase 2.)
2. **Hook coverage**: all three (`SessionStart`, `PreCompact`, `Stop`) or `PreCompact` only. (Default: all three.)
3. **Hard-purge window**: 30 days for soft-deleted items. (Default: 30.)
4. **Auto-procedure inference**: fully removed in favor of explicit `/save-procedure`. (Default: yes.)
5. **Model pinning**: Haiku 4.5 for extraction, Sonnet 4.6 for summary/dream/consolidation. Confirm before spend.
6. **Dream dry-run duration**: 3 nights before going live. (Default: 3.)

Change any default by editing this file and noting it in the PR description. Do not drift silently.

---

## 17. Out of scope (explicit)

- Open-source packaging / onboarding wizard / provider abstraction.
- Migration of existing 163 items (cutover is a wipe).
- Multi-user / multi-tenant isolation beyond the existing `group_folder` scope.
- Voice / non-Telegram channel support.
- Changing the embedding model or vector dimensions.
- Replacing `better-sqlite3` or `sqlite-vec`.

---

## 18. Glossary

- **Extraction**: turning a turn into structured memory facts.
- **Consolidation**: merging duplicate/overlapping memory items into one canonical item.
- **Dreaming**: nightly sweep that scores items, reviews with an LLM, applies keep/rewrite/merge/retire decisions.
- **Continuity brief**: the `[Memory Brief]` block injected at the top of each user turn.
- **Session summary**: markdown file written at a session boundary capturing what happened and open loops.
- **Grounding check**: post-hoc assertion that every identifier in an LLM-generated memory output appears in the inputs.
- **Group folder**: per-channel directory under `agents/` (e.g. `telegram_kai-dev`) that scopes memory and config.
- **QMD mirror**: the human-readable markdown file that mirrors a DB row, one file per id under `profile/` or `procedures/`.
