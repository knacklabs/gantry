# Gantry Architecture Blueprint & Execution Flow

This document provides a deep architectural breakdown and end-to-end execution flow of the **Gantry** agent platform (`https://github.com/knacklabs/gantry.git`).

---

## 1. High-Level Architectural Flow

```mermaid
flowchart TD
    %% INGRESS LAYER
    subgraph INGRESS["1. Ingress Layer (4 Incoming Types)"]
        direction TB
        IN_CHANNELS["📱 Channels\n(Slack, Discord, Telegram, Teams)"]
        IN_INGRESS["🌐 External Ingress\n(Webhooks / HMAC Signed)"]
        IN_SDK["💻 Gantry SDK\n(REST / OpenAPI Client)"]
        IN_CRON["⏰ Schedulers & Cron\n(pg-boss Queue Engine)"]
    end

    %% NORMALIZATION & DEDUPING
    subgraph DEDUP["2. Normalization & Deduplication"]
        direction TB
        SIG_VERIFY["Signature Verification & Auth"]
        PAYLOAD_NORM["Payload Normalization\n(into NewMessage / Domain Event)"]
        IDEM_CHECK["Idempotency & Dedup Key Hash\n(SHA-256 stableExternalIngressMessageId)"]
    end

    %% DURABLE PERSISTENCE & NOTIFICATION
    subgraph DURABLE_NOTIFY["3. Durable Storage & Notification Engine"]
        direction TB
        DB_STORE["PostgreSQL Durability\n• canonical_messages\n• live_admission_work_items\n• runtime_events outbox"]
        PG_NOTIFY["PostgreSQL pg_notify\n• gantry_live_admissions\n• gantry_live_turn_commands"]
    end

    %% WORKER ENGINE
    subgraph WORKER["4. Worker Engine (Live & Job Workers)"]
        direction TB
        ADMISSION_LOOP["Live Admission Work Loop\n(Claim Work Item with Advisory Lease)"]
        
        subgraph GROUP_QUEUE["Group Queueing (Concurrency Management)"]
            GQ_MUTEX["Queue Mutex & Per-JID Concurrency Lock\n(Only 1 active execution per conversation/thread)"]
            GQ_BACKLOG["Backlog Buffer & Rate Limiting"]
        end
        
        subgraph GROUP_PROC["Group Processing Pipeline"]
            GP_CURSOR["Message Cursor & Replay Check"]
            GP_CMD["Session Command Router (/clear, /model, etc.)"]
            GP_PROGRESS["Typing Indicator & Progress Heartbeats"]
            GP_MEM["Memory & Context Hydration"]
        end
    end

    %% AGENT RUNNER LAYER
    subgraph RUNNER["5. Agent Runner Subsystem"]
        direction TB
        SPAWNER["Agent Process Spawner & Sandbox Isolation\n(stdin config / stdout streaming / IPC directory)"]
        
        subgraph RUNNER_ENGINES["Supported Runner Engines"]
            CLAUDE_SDK["Anthropic Claude Agent\n• Claude SDK / Native Tools\n• Prompt Caching & Thinking Budget\n• Model Gateway (AWS SigV4 / Vertex / Direct)"]
            DEEP_AGENTS["DeepAgents / LangChain\n• LangGraph Stream Normalizer\n• State Backend Sandbox\n• Facade Tools & Checkpoint Saver"]
        end
        
        subgraph RUNNER_CAPABILITIES["Runtime Capabilities & Tools"]
            MCP_SERVERS["MCP Server Proxy & Tools"]
            BROWSER_RUN["Browser Automation & CDP Session"]
            SKILLS["Curated Skills (/skills/**)"]
            MEM_SYS["Memory System (Episodic / Semantic / Patterns)"]
        end
    end

    %% DATABASE / STATE LAYER
    subgraph DATABASE["6. PostgreSQL State & Audit Storage"]
        direction TB
        T_MESSAGES[("canonical_messages")]
        T_ADMISSION[("live_admission_work_items")]
        T_TURNS[("live_turns")]
        T_RUNS[("agent_runs")]
        T_SESSIONS[("agent_sessions")]
        T_EVENTS[("runtime_events")]
        T_JOBS[("jobs / pgboss.job")]
    end

    %% CONNECTIONS
    IN_CHANNELS --> SIG_VERIFY
    IN_INGRESS --> SIG_VERIFY
    IN_SDK --> SIG_VERIFY
    IN_CRON --> IDEM_CHECK

    SIG_VERIFY --> PAYLOAD_NORM --> IDEM_CHECK
    IDEM_CHECK --> DB_STORE
    DB_STORE --> PG_NOTIFY

    PG_NOTIFY -.->|Instant Wakeup Event| ADMISSION_LOOP
    DB_STORE -.->|Durable Work Claims| ADMISSION_LOOP

    ADMISSION_LOOP --> GQ_MUTEX
    GQ_MUTEX --> GQ_BACKLOG --> GP_CURSOR
    GP_CURSOR --> GP_CMD --> GP_PROGRESS --> GP_MEM

    GP_MEM --> SPAWNER
    SPAWNER --> CLAUDE_SDK & DEEP_AGENTS
    CLAUDE_SDK & DEEP_AGENTS --> MCP_SERVERS & BROWSER_RUN & SKILLS & MEM_SYS

    %% DB Read/Write flows
    DB_STORE <---> T_MESSAGES & T_ADMISSION & T_EVENTS
    ADMISSION_LOOP <---> T_ADMISSION & T_TURNS
    GP_MEM <---> T_SESSIONS & T_MESSAGES
    SPAWNER <---> T_RUNS
    RUNNER_CAPABILITIES <---> T_EVENTS
    IN_CRON <---> T_JOBS
```

---

## 2. The 4 Incoming Entrypoints

Gantry accepts work through four distinct entry mechanisms, unified into a single durable processing pipeline:

```mermaid
sequenceDiagram
    autonumber
    participant Ch as 📱 Channels (Slack/Discord/TG/Teams)
    participant Ing as 🌐 External Ingress (Webhooks)
    participant SDK as 💻 Gantry SDK (REST API)
    participant Cron as ⏰ Schedulers & Cron (pg-boss)
    participant Core as 🛡️ Gantry Core Controller
    participant DB as 🐘 PostgreSQL Database
    participant Wk as ⚙️ Live/Job Worker

    rect rgb(240, 248, 255)
        note over Ch,Core: Path A: Chat Channels
        Ch->>Core: Inbound Webhook / Socket Event
        Core->>Core: Normalize to NewMessage (sender, text, thread, chatJid)
    end

    rect rgb(255, 245, 238)
        note over Ing,Core: Path B: External Ingress
        Ing->>Core: POST /v1/external-ingress/messages (HMAC Signed)
        Core->>Core: Verify Signature + Hash Idempotency Key
    end

    rect rgb(245, 255, 245)
        note over SDK,Core: Path C: Gantry SDK
        SDK->>Core: Programmatic REST API (/v1/conversations/.../messages)
        Core->>Core: Authenticate Bearer / Service Token
    end

    rect rgb(255, 255, 240)
        note over Cron,Core: Path D: Cron & Scheduled Jobs
        Cron->>Core: pg-boss queue tick (gantry.jobs)
        Core->>Core: Claim scheduled run slot & dispatch payload
    end

    Core->>DB: ATOMIC TX: Insert message + Insert live_admission_work_items + Insert runtime_events
    DB-->>Core: TX Committed
    Core->>DB: SELECT pg_notify('gantry_live_admissions', payload)
    DB-->>Wk: Instant Wakeup Signal (LISTEN gantry_live_admissions)
```

### 2.1. Chat Channels (`apps/core/src/channels/`)
- **Supported Platforms**: Slack (Bolt / Socket Mode), Discord (`discord.js`), Telegram (`grammY`), Microsoft Teams (`botbuilder`).
- **Function**: Listens to mentions, direct messages, and group reactions.
- **Normalization**: Translates platform-specific user identities, attachments, and thread IDs into Gantry's canonical `chat_jid` and `thread_id` representations (e.g. `slack:T123:C456` or `discord:guild:channel`).

### 2.2. External Ingress (`apps/core/src/application/external-ingress/`)
- **Route**: `POST /v1/external-ingress/messages`
- **Security**: Cryptographically verified via HMAC SHA-256 signatures (`x-gantry-signature`, timestamp skew validation) using pre-shared secrets.
- **Deduplication**: Generates deterministic message IDs using `stableExternalIngressMessageId([appId, conversationId, threadId, externalMessageId])`.

### 2.3. Gantry SDK (`packages/sdk/`)
- **Clients**: TypeScript / Node.js SDK and generated OpenAPI bindings.
- **Function**: Programmatic creation of conversations, runs, tools, and message insertion.
- **Security**: OIDC / Bearer tokens validated against workspace permissions.

### 2.4. Cron & Schedulers (`apps/core/src/infrastructure/pgboss/`)
- **Engine**: `pg-boss` backed queue running inside PostgreSQL.
- **Job Types**: Recurring crons (`cron` expressions), interval timers, and one-off delayed tasks (`schedule_type: 'once'`).
- **Coordination**: Uses worker capacity locks (`tryAcquireRunSlot`) and lease management to guarantee single execution without duplicate scheduling.

---

## 3. Normalization, Deduplication & Durable Admission

Once an event arrives from any of the 4 entrypoints, Gantry ensures **zero message loss** and **idempotent execution**:

```mermaid
flowchart LR
    A[Raw Incoming Event] --> B{Verify Signature / Auth}
    B -- Invalid --> B1[401 / 403 Reject]
    B -- Valid --> C[Payload Normalizer]
    C --> D[Compute Stable Idempotency Hash]
    D --> E{Check Database for Message ID}
    E -- Duplicate --> F[Return 200 OK Accepted - Skip Queue]
    E -- New --> G[Begin PostgreSQL Transaction]
    G --> H[1. INSERT canonical_messages]
    G --> I[2. INSERT live_admission_work_items]
    G --> J[3. INSERT runtime_events]
    G --> K[4. Commit TX]
    K --> L[EXECUTE pg_notify 'gantry_live_admissions']
```

1. **Deterministic Hashing**: The idempotency key prevents duplicate webhook deliveries from external providers.
2. **Atomic Ingress Transaction**:
   - `canonical_messages`: Stores the user message text, metadata, sender ID, timestamp, and thread routing.
   - `live_admission_work_items`: Enqueues an admission work item containing the target `queue_key`, `app_id`, and `agent_id`.
   - `runtime_events`: Emits an event (`CONVERSATION_MESSAGE_INBOUND`) into the outbox for downstream streaming/audit.
3. **Instant Notification with Durable Fallback**:
   - Executes `SELECT pg_notify('gantry_live_admissions', '')` to trigger reactive wakeup in worker processes.
   - If workers are busy or restarting, the durable row in `live_admission_work_items` guarantees the message will be picked up on the next work loop tick.

---

## 4. Inside the Worker: Group Queueing & Processing

The worker subsystem manages concurrency, state recovery, and execution orchestration.

```mermaid
flowchart TD
    subgraph ADMISSION["Admission & Worker Loop"]
        WAKE[pg_notify Wakeup / Tick] --> CLAIM["Claim live_admission_work_item\n(UPDATE ... WHERE status='pending' FOR UPDATE SKIP LOCKED)"]
        CLAIM --> DISPATCH["Dispatch to GroupQueue.enqueueMessageCheck(queueJid)"]
    end

    subgraph GROUP_QUEUE["GroupQueue (Concurrency & Serialization Engine)"]
        DISPATCH --> CHK_ACTIVE{"Is Group Run Active for this JID?"}
        CHK_ACTIVE -- Yes --> Q_PENDING["Set state.pendingMessages = true\n(Buffered in Group Backlog)"]
        CHK_ACTIVE -- No --> CHK_CAPACITY{"Active Worker Runs < Max Concurrency Limit?"}
        
        CHK_CAPACITY -- Limit Reached --> Q_WAITING["Enqueue to waitingMessageGroups\n(FIFO Queue)"]
        CHK_CAPACITY -- Capacity Available --> RUN_GROUP["Start runForGroup(groupJid)"]
    end

    subgraph GROUP_PROC["Group Processing Pipeline"]
        RUN_GROUP --> FETCH_REPLAY["Fetch Messages Since Replay Cursor\n(getMessagesSince from canonical_messages)"]
        FETCH_REPLAY --> CHECK_CMD{"Is Message a Session Command?\n(/clear, /model, /job, /stop)"}
        
        CHECK_CMD -- Yes --> EXEC_CMD["Execute Command & Write Reply\n(Update Session / Clear State)"]
        CHECK_CMD -- No --> TYPING_ON["Start Typing Indicator & Progress Heartbeat"]
        
        TYPING_ON --> HYDRATE["Hydrate Memory & Turn Context\n• Load Agent Profile\n• Recall Memories & Boundaries\n• Materialize Tool & Skill Rules"]
        HYDRATE --> INVOKE_RUNNER["Call Spawner / Group Agent Runner"]
        
        INVOKE_RUNNER --> STREAM_DRAIN["Stream Response Chunks & Collect Tool Calls"]
        STREAM_DRAIN --> PERSIST_RESULT["Save Assistant Transcript & Mark Run Complete"]
    end

    subgraph DRAIN_NEXT["Group Queue Drain & Cleanup"]
        PERSIST_RESULT --> RELEASE_LOCK["Release Group Active Lock"]
        RELEASE_LOCK --> CHECK_PENDING{"Any Pending Messages for this Group?"}
        CHECK_PENDING -- Yes --> RUN_GROUP
        CHECK_PENDING -- No --> DEQUEUE_WAITING["Dequeue Next Group from waitingMessageGroups"]
        DEQUEUE_WAITING --> RUN_GROUP
    end
```

### Key Components of the Worker:
- **`GroupQueue` (`apps/core/src/runtime/group-queue.ts`)**:
  - Enforces **strict per-conversation FIFO serialization**: Only *one* agent run executes simultaneously for a given `queueJid` (conversation or thread).
  - Maintains separate queues for interactive chat messages and background tasks.
  - Exposes an interactive IPC control port for mid-flight steering, stop commands (`/stop`), and continuations.
- **`GroupProcessor` (`apps/core/src/runtime/group-processing.ts`)**:
  - Replays missed messages between the last processed cursor and now.
  - Intercepts built-in session slash commands before invoking the LLM.
  - Sends typing status indicators and progress update cards to the channel.
- **`LiveTurnAuthority` (`apps/core/src/runtime/live-turn-authority.ts`)**:
  - Issues distributed fencing tokens (`leaseToken`, `fencingVersion`) to prevent split-brain execution across multiple worker nodes.

---

## 5. Inside the Agent Runner Subsystem

When the worker decides to execute an agent turn, it delegates to the **Agent Runner**.

```mermaid
flowchart TD
    subgraph PREP["1. Runner Preparation & Sandbox Config"]
        CONFIG["Build AgentRunnerInput JSON\n• System Prompts & Personas\n• Tool Network Envs & Proxies\n• Effective Model & Thinking Budget\n• MCP Servers Config\n• Allowed Skill Paths (/skills/**)"]
    end

    subgraph SPAWN["2. Subprocess Spawning & IPC Bridge"]
        CHILD_PROC["Spawn Node.js Subprocess\n(agent-spawn-process.ts)"]
        STDIN_PIPE["Pipe Config via stdin (EOF marker)"]
        IPC_DIR["Prepare IPC Directory (GANTRY_IPC_INPUT_DIR)\n• Watch for continuation messages\n• Watch for _close sentinel"]
    end

    subgraph ENGINES["3. Runner Execution Engines"]
        direction LR
        
        subgraph CLAUDE_ENGINE["Anthropic Claude Engine"]
            CLAUDE_MATERIALIZE["Claude Config Materializer"]
            CLAUDE_LOOP["Query Loop with Native Anthropic SDK"]
            CLAUDE_PROMPT_CACHE["Prompt Caching & Thinking Budget"]
            CLAUDE_GATEWAY["Gantry Model Gateway\n(SigV4 / Vertex / Direct HTTP)"]
            CLAUDE_MATERIALIZE --> CLAUDE_LOOP --> CLAUDE_PROMPT_CACHE --> CLAUDE_GATEWAY
        end
        
        subgraph DEEP_ENGINE["DeepAgents / LangChain Engine"]
            DA_GRAPH["DeepAgent Graph Initialization"]
            DA_STREAM["LangGraph Stream Normalizer"]
            DA_SANDBOX["StateBackend Sandbox (Deny Filesystem)"]
            DA_CHECKPOINT["DeepAgent Checkpoint Store"]
            DA_GRAPH --> DA_STREAM --> DA_SANDBOX --> DA_CHECKPOINT
        end
    end

    subgraph TOOLS["4. Capability Tool Execution"]
        MCP_CLIENT["MCP Gateway & In-Process Tools"]
        BROWSER_CDP["Browser CDP Automation (Playwright/Chrome)"]
        MEMORY_IPC["Memory IPC Service (Query / Save)"]
        SCHEDULER_IPC["Scheduler Inspection IPC"]
    end

    subgraph OUTPUT["5. Streaming & Finalization"]
        STDOUT_PARSE["Parse stdout Framed Markers\n(OUTPUT_START_MARKER / OUTPUT_END_MARKER)"]
        EMIT_PROGRESS["Emit Real-time Token Stream & Tool Events"]
        TERMINAL_SUMMARY["Produce Final Run Summary & Token Usage"]
    end

    PREP --> SPAWN
    SPAWN --> CLAUDE_ENGINE & DEEP_ENGINE
    CLAUDE_ENGINE & DEEP_ENGINE <--> TOOLS
    CLAUDE_ENGINE & DEEP_ENGINE --> OUTPUT
```

### 5.1. Anthropic Claude Runner (`adapters/llm/anthropic-claude-agent/`)
- Uses Anthropic's native SDK with Claude 3.5 / 3.7 models.
- Supports structured **prompt caching** (caching system prompts, tool schemas, and conversation histories).
- Supports **extended thinking mode** with dynamically configured token budgets.
- Integrates with the **Gantry Model Gateway** for multi-cloud routing (Anthropic direct, AWS Bedrock SigV4, Google Cloud Vertex AI).

### 5.2. DeepAgents Runner (`adapters/llm/deepagents-langchain/`)
- Built on top of **LangChain** and **LangGraph**.
- Provides graph execution with stream normalization (`normalizeDeepAgentStream`).
- Sandboxes tool execution by enforcing strict filesystem and shell boundaries, routing tool operations exclusively through Gantry's verified MCP layer.

### 5.3. MCP Tooling & Runtime Isolation
- **MCP Server Proxy**: Dispatches tools for file manipulation, memory search, web scraping, and database inspection.
- **Browser Automation**: CDP-controlled Chrome sessions for visual browsing, DOM scraping, and screenshot capture with profile snapshotting.
- **File-based IPC**: Live message injection, human-in-the-loop approvals, and cancellation signals are delivered via atomic files in `GANTRY_IPC_INPUT_DIR`.

---

## 6. Database Interactions & Query Breakdown per Turn

Gantry relies on PostgreSQL for state, queueing, concurrency leases, and long-term memory.

### Complete Turn Lifecycle DB Operations:

```mermaid
sequenceDiagram
    autonumber
    participant App as 👤 User / External Ingress
    participant Core as 🛡️ Gantry Core
    participant DB as 🐘 PostgreSQL
    participant Wk as ⚙️ Worker
    participant Runner as 🤖 Agent Runner

    %% INGRESS PHASE
    rect rgb(240, 248, 255)
        note over Core,DB: Phase 1: Ingestion & Admission (1-3 Queries)
        App->>Core: Inbound Message
        Core->>DB: Q1: SELECT conversation, thread FROM canonical_conversations WHERE id = $1
        Core->>DB: Q2: INSERT INTO canonical_messages (...) VALUES (...)
        Core->>DB: Q3: INSERT INTO live_admission_work_items (queue_key, status, ...)
        Core->>DB: Q4: INSERT INTO runtime_events (...)
        Core->>DB: Q5: SELECT pg_notify('gantry_live_admissions', '')
    end

    %% WORKER PICKUP PHASE
    rect rgb(255, 245, 238)
        note over DB,Wk: Phase 2: Worker Claim & State Setup (3-5 Queries)
        DB-->>Wk: pg_notify Trigger
        Wk->>DB: Q6: UPDATE live_admission_work_items SET status='claimed', worker_id=$1 WHERE id=$2 RETURNING *
        Wk->>DB: Q7: SELECT * FROM canonical_messages WHERE chat_jid=$1 AND created_at > $2 ORDER BY created_at ASC
        Wk->>DB: Q8: SELECT * FROM agent_sessions WHERE chat_jid=$1 AND thread_id=$2
        Wk->>DB: Q9: INSERT INTO agent_runs (session_id, status, run_id, ...) VALUES (...)
        Wk->>DB: Q10: INSERT/UPDATE live_turns (turn_id, run_id, fencing_version, lease_token, ...)
    end

    %% RUNNER EXECUTION PHASE
    rect rgb(245, 255, 245)
        note over Wk,Runner: Phase 3: Agent Runner Execution & Tool Queries (2-6 Queries)
        Wk->>Runner: Spawn Subprocess (stdin JSON)
        Runner->>DB: Q11: SELECT memories FROM app_memories WHERE subject=$1 (Semantic/Pattern Recall)
        Runner->>DB: Q12: SELECT * FROM mcp_servers WHERE enabled=true
        opt Tool Execution (e.g. Memory Store or Browser Snapshot)
            Runner->>DB: Q13: INSERT INTO app_memories (...) VALUES (...)
            Runner->>DB: Q14: UPDATE browser_profile_snapshots SET state=$1 WHERE profile_id=$2
        end
    end

    %% FINALIZATION PHASE
    rect rgb(255, 255, 240)
        note over Wk,DB: Phase 4: Finalization & Audit Storage (4-5 Queries)
        Runner-->>Wk: Stream complete + Final AgentOutput
        Wk->>DB: Q15: INSERT INTO canonical_messages (sender='Gantry', content=$1, is_from_me=true, ...)
        Wk->>DB: Q16: UPDATE agent_runs SET status='completed', result_summary=$1, token_usage=$2 WHERE id=$3
        Wk->>DB: Q17: UPDATE live_admission_work_items SET status='completed', completed_at=NOW() WHERE id=$1
        Wk->>DB: Q18: UPDATE live_turns SET status='completed' WHERE turn_id=$1
        Wk->>DB: Q19: INSERT INTO runtime_events (event_type='CONVERSATION_TURN_COMPLETED', ...)
        Wk->>DB: Q20: SELECT pg_notify('gantry_live_turn_commands', ...)
    end
```

### Exact Database Call Breakdown:

| # | Step | Table / Target | Operation | Purpose | Frequency per Turn |
|---|---|---|---|---|---|
| **1** | Routing Check | `canonical_conversations`, `conversation_threads` | `SELECT` | Verify conversation and thread exist and are active | 1 |
| **2** | Message Persistence | `canonical_messages` | `INSERT / UPSERT` | Persist user message with idempotency key | 1 |
| **3** | Work Queueing | `live_admission_work_items` | `INSERT` | Queue admission item for distributed workers | 1 |
| **4** | Outbox Event | `runtime_events` | `INSERT` | Publish `CONVERSATION_MESSAGE_INBOUND` audit event | 1 |
| **5** | Real-time Wakeup | PostgreSQL Channel | `pg_notify` | Wake up listening live workers immediately | 1 |
| **6** | Work Item Claim | `live_admission_work_items` | `UPDATE ... FOR UPDATE SKIP LOCKED` | Claim work item with worker instance ID | 1 |
| **7** | Replay Retrieval | `canonical_messages` | `SELECT ... WHERE created_at > cursor` | Load missed messages to construct turn context | 1 |
| **8** | Session Resolution | `agent_sessions` | `SELECT / INSERT` | Retrieve or initialize conversation session | 1 |
| **9** | Agent Run Registration | `agent_runs` | `INSERT` | Mint new run row with status `running` | 1 |
| **10** | Fenced Turn Lease | `live_turns` | `INSERT / UPSERT` | Register active live turn with distributed fencing token | 1 |
| **11** | Memory Retrieval | `memories`, `pattern_candidates` | `SELECT` | Vector / keyword recall for relevant context | 1 |
| **12** | MCP / Capabilities | `mcp_servers`, `agent_capabilities` | `SELECT` | Load authorized tool definitions | 1 |
| **13-14** | Tool Invocations | `app_memories`, `browser_profiles` | `INSERT / UPDATE` | Tool operations (dynamic depending on model actions) | 0 - N |
| **15** | Assistant Transcript | `canonical_messages` | `INSERT` | Persist final assistant response message | 1 |
| **16** | Run Completion | `agent_runs` | `UPDATE` | Save token usage, execution duration, status | 1 |
| **17** | Admission Finalization | `live_admission_work_items` | `UPDATE` | Mark work item `completed` | 1 |
| **18** | Turn Lease Release | `live_turns` | `UPDATE` | Mark live turn `completed` and release lock | 1 |
| **19** | Completion Event | `runtime_events` | `INSERT` | Publish `CONVERSATION_TURN_COMPLETED` | 1 |
| **20** | Outbound Delivery | `canonical_message_deliveries` | `INSERT / UPDATE` | Settle channel delivery status to external chat app | 1 |

> **Total Database Queries per Standard Turn**: ~**15 to 20 queries**, fully transactional with zero polling delay under normal execution.

---

## 7. Summary of Gantry's Core Architectural Guarantees

1. **4 Unified Ingress Vectors**: Chat channels, external signed webhooks, REST SDK, and cron schedulers all funnel into a single normalized data pipeline.
2. **Durable-First Design**: No turn is executed strictly in memory; all inputs, state transitions, and outputs are durably committed to PostgreSQL before and after execution.
3. **Strict Per-Group Concurrency**: `GroupQueue` guarantees that only one agent runs at any time per conversation thread, preventing race conditions while queuing follow-ups cleanly.
4. **Isolated Runner Architecture**: The LLM runner executes in a separate subprocess with sandboxed capabilities, streaming chunks over framed stdout and accepting live steering via file IPC.
5. **Dual LLM Engines**: Seamless support for both Anthropic Claude SDK (with prompt caching and extended thinking) and DeepAgents/LangChain.
