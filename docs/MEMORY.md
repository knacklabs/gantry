# Memory System

MyClaw's memory system provides persistent, searchable context across conversations. It combines structured fact storage with semantic search over documents.

## Architecture

Two storage layers work together:

1. **SQLite + sqlite-vec** — Primary store. Fast indexed queries, full-text search (BM25), and vector similarity search (3072-dim embeddings). Source of truth for all reads.
2. **Markdown mirror (QMD)** — Optional durable backup. Mirrors every write to human-readable markdown files. Never read by the search pipeline; exists for auditability and portability.

## Providers

Set via `MEMORY_PROVIDER` environment variable.

### `sqlite` (default)

SQLite-only. All data lives in `MEMORY_SQLITE_PATH` (default: `store/memory.db`).

Best for: Simple setups where you don't need filesystem-level memory inspection.

### `qmd` (recommended for production)

SQLite + markdown mirroring. Requires `AGENT_MEMORY_ROOT` to be set to an absolute path.

Best for: Production use where you want both fast search AND a durable, human-readable audit trail.

**How QMD works:**

- All reads go through SQLite (fast, indexed)
- All writes go to SQLite first, then mirror to markdown
- Markdown files are a one-way mirror, not a source of truth
- If SQLite is lost, markdown provides a recoverable backup (requires re-ingestion)

**Directory structure created by QMD:**

```
AGENT_MEMORY_ROOT/
├── profile/           # Memory items as individual .md files
├── procedures/        # Learned procedures as .md files
├── sessions/          # Archived conversation transcripts
│   └── YYYY/MM/DD/    # Organized by date
├── journal/           # Event audit log
│   └── YYYY/MM/       # Daily journal files
├── knowledge/         # Reserved for future use
├── .raw/              # Raw data storage
└── .cache/
    └── memory.db      # SQLite database (QMD creates it here)
```

**Mirrored files format:**

Memory items are written to `profile/{id}.md`:

```markdown
# Memory Item

id: mem-1712761353000-a1b2c3d4
scope: group
group_folder: telegram_kai-dev
kind: preference
key: code-style
source: agent
confidence: 0.8
version: 1

## Value

Prefer explicit error handling over silent failures
```

Procedures are written to `procedures/{id}.md` with similar frontmatter plus a `## Body` section.

**Journal entries** are appended to `journal/YYYY/MM/YYYY-MM-DD.md`:

```markdown
## 2026-04-11T12:34:56.000Z - memory-saved

- id: mem-1712761353000-a1b2c3d4
- scope: group
- key: code-style
- kind: preference
- profile_path: /path/to/profile/mem-1712761353000-a1b2c3d4.md
```

**Session archives** are written to `sessions/YYYY/MM/DD/{time}-{cause}-{slug}.md` with YAML frontmatter (session_id, group_folder, cause, archived_at) followed by the conversation transcript.

## Data Model

### Memory Items (structured facts)

Stored in `memory_items` table. Created via `memory_save` MCP tool.

| Field        | Type | Description                                                  |
| ------------ | ---- | ------------------------------------------------------------ |
| id           | text | `mem-{timestamp}-{hex}`                                      |
| scope        | text | `user`, `group`, or `global`                                 |
| group_folder | text | Which group owns this                                        |
| user_id      | text | For user-scoped items                                        |
| kind         | text | `preference`, `fact`, `context`, `correction`, `recent_work` |
| key          | text | Normalized identifier                                        |
| value        | text | The actual content                                           |
| confidence   | real | 0.0-1.0                                                      |
| version      | int  | Optimistic concurrency (increments on patch)                 |

### Memory Chunks (document segments)

Stored in `memory_chunks` table. Created by the ingestion pipeline.

| Field          | Type | Description                              |
| -------------- | ---- | ---------------------------------------- |
| source_type    | text | `claude_md`, `local_doc`, `conversation` |
| source_id      | text | Unique identifier for the source         |
| chunk_hash     | text | SHA256 for deduplication                 |
| text           | text | Chunk content                            |
| embedding_json | text | 3072-dim vector as JSON array            |

### Procedures (learned workflows)

Stored in `memory_procedures` table. Created via `procedure_save` MCP tool.

Procedures have a title, body, tags, and the same scope/confidence/version fields as items.

## Scoping

Three levels of isolation:

| Scope    | Readable by             | Writable by             |
| -------- | ----------------------- | ----------------------- |
| `global` | All groups              | Main group only         |
| `group`  | That group              | That group              |
| `user`   | That user in that group | That user in that group |

Default scope is controlled by `MEMORY_SCOPE_POLICY` (default: `group`).

Non-main groups cannot write global memory or access other groups' memory.

## Ingestion Pipeline

MyClaw automatically chunks and embeds documents into searchable memory.

### What gets ingested

Per group, on each incoming message or scheduled task:

1. `groups/{group}/CLAUDE.md` — source type: `claude_md`
2. `groups/{group}/memory/**/*.md` — source type: `local_doc` (recursive)

### How ingestion works

1. Read file content
2. Split into chunks (default: 1400 chars with 240 char overlap)
3. Filter out chunks < 30 chars
4. Deduplicate by SHA256 hash (scope + group + source + text)
5. Embed new chunks via OpenAI API when embeddings are enabled (text-embedding-3-large, 3072 dims)
6. Store in SQLite with FTS5 index and sqlite-vec vector index

Ingestion is idempotent. Unchanged chunks are skipped via hash comparison.

### Adding external memory files

To import memory from another system:

1. Place `.md` files in `groups/{group}/memory/`
2. Subdirectories are supported (e.g., `memory/entities/`, `memory/corrections/`)
3. Files will be auto-ingested on the next message to that group
4. Embedding cost: ~$0.01 per 100KB of text

## Search

The `memory_search` MCP tool performs hybrid retrieval.

### How search works

1. **Lexical search (BM25)**: SQLite FTS5 with unicode61 tokenization. AND-joined quoted tokens. Score normalized to [0,1].
2. **Vector search (semantic)**: Embed the query, find nearest neighbors via sqlite-vec. Distance converted to similarity score.
3. **Reciprocal Rank Fusion**: Combines both result sets with K=60 constant. `fused_score = sum(1 / (K + rank + 1))` across both channels.
4. Return top N results (default: 8, configurable via `MEMORY_RETRIEVAL_LIMIT`).

### Known limitations

These planned memory features are not yet implemented in MyClaw (see issue #16):

- **Temporal decay**: Older memories rank the same as recent ones
- **MMR reranking**: No diversity-aware deduplication of results
- **minScore filtering**: Low-relevance results are not filtered out
- **Weight tuning**: No configurable balance between lexical and vector scores

## MCP Tools

Agents interact with memory through these MCP tools:

| Tool              | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- |
| `memory_save`     | Save a structured fact (key/value with scope, kind, confidence) |
| `memory_search`   | Hybrid search across chunks and items                           |
| `memory_patch`    | Update an existing item (optimistic concurrency via version)    |
| `procedure_save`  | Save a reusable workflow/procedure                              |
| `procedure_patch` | Update an existing procedure                                    |

## Reflection (auto-capture)

After each conversation turn, MyClaw can extract facts from the exchange:

- Detects preferences, corrections, and conventions via regex patterns
- Saves with reflection-derived confidence scores (preference: 0.82, correction: 0.80, convention: 0.78)
- Filters out sensitive content (API keys, tokens, passwords)
- Capped at `MEMORY_REFLECTION_MAX_FACTS_PER_TURN` (default: 6)

## Retention Policies

Applied per group during ingestion:

| Policy               | Default  | Description                   |
| -------------------- | -------- | ----------------------------- |
| Chunk age            | 120 days | Delete chunks older than this |
| Max chunks/group     | 6000     | Keep newest, delete oldest    |
| Max procedures/group | 500      | Soft-delete lowest confidence |
| Max events           | 20,000   | Hard-delete oldest            |

## Configuration Reference

| Variable                               | Default                  | Description                                                       |
| -------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `MEMORY_PROVIDER`                      | `sqlite`                 | `sqlite` or `qmd`                                                 |
| `MEMORY_SQLITE_PATH`                   | `store/memory.db`        | SQLite database location                                          |
| `AGENT_MEMORY_ROOT`                    | (empty)                  | Required for QMD. Absolute path for markdown mirror               |
| `MEMORY_EMBED_MODEL`                   | `text-embedding-3-large` | OpenAI embedding model                                            |
| `MEMORY_EMBED_PROVIDER`                | `disabled`               | Embedding provider (`disabled` by default, `openai` when enabled) |
| `MEMORY_EMBED_BATCH_SIZE`              | 16                       | Texts per embedding API call                                      |
| `MEMORY_VECTOR_DIMENSIONS`             | 3072                     | Vector dimensions (must match model)                              |
| `MEMORY_CHUNK_SIZE`                    | 1400                     | Characters per chunk                                              |
| `MEMORY_CHUNK_OVERLAP`                 | 240                      | Overlap between chunks                                            |
| `MEMORY_RETRIEVAL_LIMIT`               | 8                        | Default results per search                                        |
| `MEMORY_SCOPE_POLICY`                  | `group`                  | Default scope for new items                                       |
| `MEMORY_CHUNK_RETENTION_DAYS`          | 120                      | Max chunk age                                                     |
| `MEMORY_MAX_CHUNKS_PER_GROUP`          | 6000                     | Max chunks per group                                              |
| `MEMORY_MAX_PROCEDURES_PER_GROUP`      | 500                      | Max procedures per group                                          |
| `MEMORY_MAX_EVENTS`                    | 20000                    | Max event log entries                                             |
| `MEMORY_REFLECTION_MIN_CONFIDENCE`     | 0.7                      | Min confidence for auto-captured facts                            |
| `MEMORY_REFLECTION_MAX_FACTS_PER_TURN` | 6                        | Max facts extracted per turn                                      |

## Switching to QMD

1. Set environment variables:

   ```bash
   MEMORY_PROVIDER=qmd
   AGENT_MEMORY_ROOT=/absolute/path/to/memory
   ```

2. Restart MyClaw. QMD creates the directory structure automatically.

3. Existing SQLite data continues to work. New writes will also mirror to markdown.

4. To verify: check that `profile/` and `journal/` directories populate after the next conversation.
