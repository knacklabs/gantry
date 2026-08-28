# Gantry Comprehensive Code-Level Deep Dive

This document details the exact internal mechanics, execution steps, and code implementations of the **Gantry** runtime platform.

---

## 1. Worker Subsystem: Group Queueing & Group Processing

The Worker subsystem manages work item claiming, concurrency serialization, state recovery, and execution orchestration.

### 1.1. Admission Loop & Claiming (`apps/core/src/runtime/live-admission-work-loop.ts`)
1. **Reactive Trigger via PostgreSQL `LISTEN`**:
   - `PostgresWakeupSource` in `live-admission-notify.postgres.ts` maintains a dedicated `PoolClient` listening on `gantry_live_admissions`.
   - When a notification arrives, it triggers `admissionLoop.trigger()`.
2. **Advisory Lease & Work Claim**:
   - Calls `claimLiveAdmissionWorkItems({ appId, workerInstanceId })`.
   - Executes atomic row claiming:
     ```sql
     UPDATE live_admission_work_items
     SET status = 'claimed',
         claimed_by_worker_instance_id = $1,
         claimed_at = NOW(),
         lease_expires_at = NOW() + INTERVAL '60 seconds'
     WHERE id IN (
       SELECT id FROM live_admission_work_items
       WHERE status = 'pending' AND app_id = $2
       ORDER BY created_at ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *;
     ```
3. **Dispatch to `GroupQueue`**:
   - For each claimed work item, calls `app.queue.enqueueMessageCheck(queueJid)`.

---

### 1.2. `GroupQueue` Concurrency Engine (`apps/core/src/runtime/group-queue.ts`)
`GroupQueue` enforces **strict FIFO single-concurrency per conversation/thread**:

```mermaid
flowchart TD
    A[enqueueMessageCheck groupJid] --> B{state.active == true?}
    B -- Yes (Turn in Progress) --> C[state.pendingMessages = true\nBuffered in Group State]
    B -- No (Idle) --> D{activeMessageCount >= maxMessageRuns?}
    
    D -- Limit Reached --> E[waitingMessageGroups.push groupJid\nFIFO Queue]
    D -- Under Limit --> F[activeMessageCount++\nrunForGroup groupJid]
    
    F --> G[Execute GroupProcessor]
    G --> H[Finally: activeMessageCount--\nstate.active = false]
    H --> I[drainGroup groupJid]
    
    I --> J{state.pendingMessages == true?}
    J -- Yes --> F
    J -- No --> K[dequeueWaitingGroup\nRefill Concurrency Slots]
```

- **Per-JID Concurrency Mutex**:
  - `groups.get(groupJid)` tracks `active: boolean`, `pendingMessages: boolean`, `process: ChildProcess`, and `retryCount`.
  - If a message arrives while an agent run is active for that JID, `state.pendingMessages` is flagged `true` and the message check is deferred.
- **Mid-Flight Steering & IPC Control**:
  - `sendMessage(groupJid, text, options)`: If an agent run is active, writes a follow-up JSON file to the child process's IPC directory and invokes `continuationHandler()`.
  - `closeStdin(groupJid)`: Writes the `_close` sentinel to signal the running agent to conclude its turn.
  - `stopGroup(groupJid)`: Kills the active subprocess if a user issues `/stop`.
- **Exponential Backoff on Failure**:
  - `delayMs = baseRetryMs * 2^(retryCount - 1)`.

---

### 1.3. `GroupProcessor` Execution Pipeline (`apps/core/src/runtime/group-processing.ts`)
1. **Replay Cursor Reconciliation**:
   - Reads the last processed cursor for the queue.
   - Calls `collectPendingMessagesSince()` to query `canonical_messages` where `created_at > cursor`.
   - Guarantees zero dropped messages across worker crashes or reconnects.
2. **Session Command Interception (`handleSessionCommand`)**:
   - Checks if the user message matches built-in administrative or session commands:
     - `/clear` or `/reset`: Resets conversation memory and session state.
     - `/model <name>`: Updates the active model configuration for the thread.
     - `/stop` or `/abort`: Cancels any running agent turn.
     - `/job`: Inspects or configures scheduled recurring tasks.
   - If intercepted, executes the command directly without invoking the LLM.
3. **Typing Indicators & Progress Heartbeats**:
   - `createGroupTurnTypingSender`: Sends platform typing indicators (e.g. Slack typing or Discord typing) every 4 seconds.
   - `createProgressChannelSender`: Posts or updates ephemeral progress cards.
4. **Memory & Context Hydration**:
   - Queries `app_memories` and `pattern_candidates` using vector similarity or keyword recall for the conversation subject.
   - Materializes approved skills and tool capability rules.
5. **Invoking `spawnAgent`**:
   - Hands off the constructed prompt and runtime policy to the Agent Runner.

---

## 2. Agent Runner Subsystem: Claude SDK vs DeepAgents

Gantry supports two distinct agent execution engines isolated in separate child processes.

```mermaid
flowchart LR
    subgraph SPAWNER["Runner Spawner (agent-spawn.ts)"]
        direction TB
        INPUT_JSON["AgentRunnerInput JSON\n• System Prompts & Boundaries\n• Tool Network Envs\n• Effective Model & Thinking Config\n• MCP Server Configurations\n• Allowed Skill Paths (/skills/**)"]
        SPAWN_PROC["child_process.spawn(node, [runner/index.js])\n• Stdin: Input JSON (EOF)\n• Stdout: Framed Markers\n• IPC: GANTRY_IPC_INPUT_DIR"]
    end

    subgraph CLAUDE_LANE["Anthropic Claude Engine"]
        direction TB
        CL_CONFIG["1. Model Config & Thinking Budget\n(resolveThinkingOptions)"]
        CL_CACHE["2. Prompt Caching Materializer\n(Cache system prompt + tool schemas)"]
        CL_GATEWAY["3. Gantry Model Gateway\n• Direct Anthropic API\n• AWS Bedrock SigV4\n• GCP Vertex AI OAuth"]
        CL_LOOP["4. Query Stream Loop\n(Anthropic SDK Client Events)"]
        CL_CONFIG --> CL_CACHE --> CL_GATEWAY --> CL_LOOP
    end

    subgraph DEEP_LANE["DeepAgents / LangChain Engine"]
        direction TB
        DA_FACTORY["1. LangChain Model Factory\n(OpenAI / OpenRouter / Anthropic)"]
        DA_SANDBOX["2. StateBackend Sandbox\n(DENY_ALL_FILESYSTEM + /skills/**)"]
        DA_GRAPH["3. DeepAgents Graph Compiler\n(createDeepAgent)"]
        DA_NORM["4. Stream Normalizer\n(LangGraph streamEvents v2)"]
        DA_FACTORY --> DA_SANDBOX --> DA_GRAPH --> DA_NORM
    end

    INPUT_JSON --> SPAWN_PROC
    SPAWN_PROC --> CLAUDE_LANE
    SPAWN_PROC --> DEEP_LANE
```

---

### 2.1. Anthropic Claude SDK Engine (`apps/core/src/adapters/llm/anthropic-claude-agent/`)

#### 1. Entry & IPC Setup (`runner/index.ts`)
- The subprocess reads the serialized `AgentRunnerInput` from `stdin` until EOF.
- Initializes `GANTRY_IPC_INPUT_DIR` to watch for interactive continuation messages.

#### 2. Prompt Caching & Thinking Budgets (`runner/model-config.ts` & `claude-config-materializer.ts`)
- **Prompt Caching**:
  - Injects `cache_control: { type: "ephemeral" }` at 3 strategic breakpoints:
    1. System prompt & base persona instructions.
    2. Materialized MCP tool definition schemas.
    3. Conversation message history boundary.
  - Achieves up to **90% token cost reduction** and **80% latency reduction** on long-running multi-turn sessions.
- **Extended Thinking**:
  - Configures Anthropic's native thinking budget (`thinking: { type: "enabled", budget_tokens: ... }`) based on agent effort settings.

#### 3. Gantry Model Gateway (`gantry-model-gateway.ts`)
Enables enterprise multi-cloud dispatch without rewriting prompt or tool code:
- **Direct Anthropic**: `https://api.anthropic.com/v1/messages` using standard API keys.
- **AWS Bedrock**: Signs HTTP requests on-the-fly with AWS Signature Version 4 (`SigV4`) using ambient AWS IAM credentials or Secrets Manager.
- **Google Cloud Vertex AI**: Obtains and refreshes GCP OAuth access tokens for Vertex Claude endpoints.

#### 4. Query Loop & Tool Execution (`runner/query-loop.js`)
- Consumes the native stream:
  - Text deltas are wrapped in `OUTPUT_START_MARKER` and `OUTPUT_END_MARKER` and written to `stdout`.
  - Tool invocations (e.g. `RunCommand`, `ReadFiles`, `BrowserAction`, `MemorySave`) are routed to the local MCP proxy.
- Polls `GANTRY_IPC_INPUT_DIR`:
  - If a user sends a message while the model is thinking or running tools, it injects the new text directly into the active session without aborting.

---

### 2.2. DeepAgents / LangChain Engine (`apps/core/src/adapters/llm/deepagents-langchain/`)

#### 1. Model Factory (`runner/model-factory.ts`)
- Instantiates LangChain chat models (`buildRunnerModel`):
  - Supports OpenAI, OpenRouter, Azure OpenAI, Anthropic, or custom local models.
  - Injects provider preferences and cache control headers.

#### 2. Sandboxing & StateBackend (`runner/deep-agent-runner.ts`)
- **Raw Filesystem Access Denied**:
  ```typescript
  const DENY_ALL_FILESYSTEM: FilesystemPermission[] = [
    { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
  ];
  const READONLY_SKILLS_FILESYSTEM: FilesystemPermission[] = [
    { operations: ['read'], paths: ['/skills', '/skills/**'] },
    { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
  ];
  ```
- **Unsafe Tool Exclusion**:
  - `createBuiltinToolExclusionMiddleware` strips internal subagent task tools (`task`, `write_todos`) to ensure all actions route through reviewed Gantry MCP tools.

#### 3. Graph Compilation & Stream Normalization (`runner/stream-normalizer.ts`)
- Compiles the LangGraph workflow (`createDeepAgent`).
- Subscribes to LangGraph's `streamEvents({ version: 'v2' })`:
  - `on_chat_model_stream`: Normalizes token deltas to Gantry stdout chunks.
  - `on_tool_start`: Emits tool call activity events (`tool_name`, `tool_input`, `tool_call_id`).
  - `on_tool_end`: Emits tool result summaries.
- **Session Checkpointing**:
  - `DeepAgentCheckpointSaver` saves intermediate LangGraph state checkpoints for session resumes.

---

## 3. Database State & 20 Queries per Turn Breakdown

```mermaid
sequenceDiagram
    autonumber
    participant Client as 👤 Ingress / User
    participant Core as 🛡️ Gantry Core
    participant DB as 🐘 PostgreSQL
    participant Worker as ⚙️ Worker Process
    participant Runner as 🤖 Child Runner

    %% INGRESS
    rect rgb(240, 248, 255)
        note over Core,DB: Phase 1: Ingestion & Ingress Commit (Queries 1-5)
        Client->>Core: Inbound Webhook / API Message
        Core->>DB: Q1: SELECT FROM canonical_conversations WHERE id = $1
        Core->>DB: Q2: INSERT INTO canonical_messages (...)
        Core->>DB: Q3: INSERT INTO live_admission_work_items (...)
        Core->>DB: Q4: INSERT INTO runtime_events (...)
        Core->>DB: Q5: SELECT pg_notify('gantry_live_admissions', '')
    end

    %% WORKER PICKUP
    rect rgb(255, 245, 238)
        note over DB,Worker: Phase 2: Worker Claim & State Setup (Queries 6-10)
        DB-->>Worker: pg_notify Trigger
        Worker->>DB: Q6: UPDATE live_admission_work_items SET status='claimed' FOR UPDATE SKIP LOCKED
        Worker->>DB: Q7: SELECT FROM canonical_messages WHERE created_at > cursor
        Worker->>DB: Q8: SELECT FROM agent_sessions WHERE chat_jid=$1 AND thread_id=$2
        Worker->>DB: Q9: INSERT INTO agent_runs (session_id, status='running')
        Worker->>DB: Q10: INSERT/UPDATE live_turns (lease_token, fencing_version)
    end

    %% RUNNER TOOLS
    rect rgb(245, 255, 245)
        note over Worker,Runner: Phase 3: Runner Execution & Tool Queries (Queries 11-14)
        Worker->>Runner: Spawns Child Subprocess (stdin JSON)
        Runner->>DB: Q11: SELECT FROM app_memories / pattern_candidates (Semantic Recall)
        Runner->>DB: Q12: SELECT FROM mcp_servers WHERE enabled=true
        opt Tool Execution
            Runner->>DB: Q13: INSERT INTO app_memories (...)
            Runner->>DB: Q14: UPDATE browser_profile_snapshots (...)
        end
    end

    %% FINALIZATION
    rect rgb(255, 255, 240)
        note over Worker,DB: Phase 4: Finalization & Audit (Queries 15-20)
        Runner-->>Worker: Stream complete (OUTPUT_END)
        Worker->>DB: Q15: INSERT INTO canonical_messages (Assistant Reply)
        Worker->>DB: Q16: UPDATE agent_runs SET status='completed', usage=$1
        Worker->>DB: Q17: UPDATE live_admission_work_items SET status='completed'
        Worker->>DB: Q18: UPDATE live_turns SET status='completed' (Release Lease)
        Worker->>DB: Q19: INSERT INTO runtime_events ('CONVERSATION_TURN_COMPLETED')
        Worker->>DB: Q20: INSERT/UPDATE canonical_message_deliveries (Settle Channel)
    end
```

### Complete Query Breakdown:

| # | Step | Table | SQL Operation | Purpose |
|---|---|---|---|---|
| **1** | Routing Verification | `canonical_conversations`, `conversation_threads` | `SELECT` | Verify conversation and thread exist and are active |
| **2** | Message Persistence | `canonical_messages` | `INSERT / UPSERT` | Persist user message with SHA-256 idempotency key |
| **3** | Work Queueing | `live_admission_work_items` | `INSERT` | Queue admission item for distributed workers |
| **4** | Inbound Audit Outbox | `runtime_events` | `INSERT` | Publish `CONVERSATION_MESSAGE_INBOUND` event |
| **5** | Reactive Wakeup | PostgreSQL Channel | `pg_notify` | Wake up listening live workers immediately |
| **6** | Work Item Claim | `live_admission_work_items` | `UPDATE ... FOR UPDATE SKIP LOCKED` | Claim work item with worker instance ID |
| **7** | Replay Retrieval | `canonical_messages` | `SELECT ... WHERE created_at > cursor` | Load missed messages to construct turn context |
| **8** | Session Resolution | `agent_sessions` | `SELECT / INSERT` | Retrieve or initialize conversation session |
| **9** | Agent Run Registration | `agent_runs` | `INSERT` | Mint new run row with status `running` |
| **10** | Fenced Turn Lease | `live_turns` | `INSERT / UPSERT` | Register active live turn with distributed fencing token |
| **11** | Memory Retrieval | `app_memories`, `pattern_candidates` | `SELECT` | Vector / keyword recall for relevant context |
| **12** | MCP / Capabilities | `mcp_servers`, `agent_capabilities` | `SELECT` | Load authorized tool definitions |
| **13-14** | Tool Invocations | `app_memories`, `browser_profile_snapshots` | `INSERT / UPDATE` | Tool operations (dynamic depending on model actions) |
| **15** | Assistant Transcript | `canonical_messages` | `INSERT` | Persist final assistant response message |
| **16** | Run Completion | `agent_runs` | `UPDATE` | Save token usage, execution duration, status |
| **17** | Admission Finalization | `live_admission_work_items` | `UPDATE` | Mark work item `completed` |
| **18** | Turn Lease Release | `live_turns` | `UPDATE` | Mark live turn `completed` and release lock |
| **19** | Completion Event | `runtime_events` | `INSERT` | Publish `CONVERSATION_TURN_COMPLETED` |
| **20** | Outbound Delivery | `canonical_message_deliveries` | `INSERT / UPDATE` | Settle channel delivery status to external chat app |
