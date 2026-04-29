# OpenClaw vs MyClaw — What's the Difference?

> Written for humans, not architects. No jargon where plain English works.

---

## One-line summary

| | What it is |
|---|---|
| **OpenClaw** | A full personal AI *platform* — runs across every messaging app, with voice, mobile apps, a visual canvas, Docker isolation, and support for any AI provider. |
| **MyClaw** | A lean personal AI *runtime* — small enough to understand, Claude-only, runs on your Mac, customized by changing code rather than stacking configuration. |

---

## The core philosophical split

**OpenClaw** is built on the premise: *"Give me one AI assistant reachable from every channel I already use — WhatsApp, iMessage, Telegram, Slack, Discord, Signal, Teams — all talking to the same agent, on my own hardware."*

**MyClaw** is built on the premise: *"Give me a single process I can read top-to-bottom and modify. Don't bury behavior in plugins and config files. Keep it tight, keep it Claude, make it yours."*

One is maximalist and platform-oriented. The other is minimalist and developer-oriented.

---

## Architecture

### OpenClaw: Hub-and-spoke

```
WhatsApp ─┐
Telegram  ├──► Gateway (WebSocket server) ──► Agent Runtime (Pi Agent Core)
Slack     │         │
Discord   ┘    Web UI / CLI / iOS / Android / macOS app
```

There's a central **Gateway** — a WebSocket server that every client connects to. It's the single source of truth for routing, sessions, presence, health monitoring, and security. Channel adapters plug into it. Control interfaces (web UI, CLI, mobile apps, macOS menu bar) connect to it as WebSocket clients.

### MyClaw: Single process

```
Telegram ─┐
Slack     ├──► Core runtime (Node.js) ──► Agent runner (Claude Code SDK)
          └         │
             SQLite + IPC files
```

No separate server. No WebSocket protocol. One Node.js process reads messages from channels, stores them in SQLite, and spawns agent runner subprocesses via IPC files when it's time to think. The agent runner runs Claude Code and streams output back. The whole thing boots with `npm run start`.

---

## Key differences, one by one

### 1. AI engine

| OpenClaw | MyClaw |
|---|---|
| **Multi-provider**: Claude, GPT-4, Gemini, local models (Ollama etc.) | **Claude-only**: uses the Anthropic Claude Agent SDK directly |
| You configure which model per agent/session | Model set via `ANTHROPIC_MODEL` env var |
| Pi Agent Core library handles the loop | Claude Code agent handles the loop |

**What this means in practice:** OpenClaw lets you swap LLMs without touching code. MyClaw bets everything on Claude — the whole skill/permission/IPC system is shaped around how Claude Code works.

---

### 2. Channels

| OpenClaw | MyClaw |
|---|---|
| WhatsApp, iMessage, Telegram, Discord, Slack, Signal, Microsoft Teams, + plugins | Telegram, Slack |
| WhatsApp via Baileys (QR pairing) | — |
| iMessage (requires real Mac) | — |
| Custom channel plugins via extension system | Feature branches (`skill/add-telegram`, `skill/add-slack`) |

**What this means in practice:** OpenClaw is for people who live across many messaging apps and want one assistant everywhere. MyClaw currently targets Slack-first workflows (business/team use).

---

### 3. Security and sandboxing

| OpenClaw | MyClaw |
|---|---|
| **Docker sandboxing** for DM and group sessions | **Host execution** only — no containers |
| Main session = full host access; DM/group = isolated containers | All sessions run on the host |
| Device pairing with challenge-response signing | OneCLI credential vault |
| Session trust levels (main > DM > group) with layered tool policies | Permission profiles per agent (YAML), with rate limits and tool allowlists |

**What this means in practice:** OpenClaw's security model assumes you're letting strangers (or semi-trusted people) talk to your bot. Docker is how it contains the blast radius if a message contains prompt injection or gets abused. MyClaw assumes you control who's in your channels — security comes from Slack/Telegram allowlists and the agent's permission profile, not container isolation.

---

### 4. Control interfaces

| OpenClaw | MyClaw |
|---|---|
| Web UI (served from Gateway) | — |
| CLI (`openclaw gateway`, `openclaw agent`, `openclaw doctor`) | CLI (`myclaw setup`, `myclaw status`, `myclaw doctor`) |
| macOS menu bar app (Swift, native) | launchd service (via `myclaw service install`) |
| iOS app | — |
| Android app | — |
| Voice Wake ("Hey OpenClaw") + Talk Mode | — |
| Canvas (agent-driven visual workspace, A2UI) | — |

**What this means in practice:** OpenClaw is a product with native apps. MyClaw is a developer tool you run as a background service and manage via Claude Code or CLI.

---

### 5. Skills and extensibility

| OpenClaw | MyClaw |
|---|---|
| Plugin system: channel plugins, memory plugins, tool plugins, provider plugins | Skills: instruction-only, utility (code), feature branches, custom |
| Plugins discovered via `package.json` `openclaw.extensions` field | Skills live in `~/myclaw/.claude/skills/` |
| Selective skill injection per turn (only injects relevant skills) | Skills loaded via `CLAUDE.md` context at agent startup |
| System prompt built from `AGENTS.md` + `SOUL.md` + `TOOLS.md` | System prompt compiled from `CLAUDE.md` + skill files per agent |

**What this means in practice:** OpenClaw has a formal plugin registry and hot-loading. MyClaw's extensibility is closer to "edit the files" — you add skills as CLAUDE.md instruction files or feature branches and rebuild.

---

### 6. Memory system

Both use SQLite with vector embeddings and hybrid search (semantic + keyword). The approach is similar. MyClaw has some additional features baked into config:

| Feature | OpenClaw | MyClaw |
|---|---|---|
| Vector + BM25 hybrid search | ✓ | ✓ |
| Embedding providers | OpenAI, Gemini, local | OpenAI (+ disable option) |
| Memory files (`MEMORY.md`, daily notes) | ✓ | ✓ |
| Memory consolidation (cluster + summarize) | — | ✓ (opt-in) |
| Memory dreaming (overnight promotion/decay) | — | ✓ (opt-in) |
| Semantic deduplication | — | ✓ |
| Per-group memory isolation | ✓ | ✓ |

---

### 7. Deployment

| OpenClaw | MyClaw |
|---|---|
| Local dev (`pnpm dev`) | Local dev (`npm run dev`) |
| macOS LaunchAgent (menu bar app manages it) | macOS launchd via `myclaw service install` |
| Linux/VPS via systemd + SSH tunnel or Tailscale | Linux via systemd |
| Fly.io container (managed HTTPS, persistent volume) | — |

---

## What MyClaw borrows from OpenClaw

MyClaw clearly took inspiration from OpenClaw's ideas:

- **Same core pattern**: channels → message storage → agent runtime → output back to channel
- **Same file layout concept**: `~/myclaw/` mirrors `~/.openclaw/`
- **Same skill philosophy**: composable instruction files (`CLAUDE.md`, `SKILL.md`) rather than hard-coded prompts
- **Same memory approach**: SQLite + semantic search, per-session isolation
- **Same service management**: launchd on macOS, systemd on Linux
- **Same IPC concept**: file-based communication between the main process and agent subprocess

---

## Where MyClaw goes its own direction

| Decision | MyClaw's take |
|---|---|
| **No WebSocket Gateway** | One process is simpler to debug and deploy than a server you connect clients to |
| **Claude-only** | Deep integration with Claude Code SDK — permission system, IPC protocol, skill injection — all shaped around how Claude works |
| **No Docker** | Assumes trusted channels; host execution is simpler and avoids container overhead |
| **No native apps** | Managed via Claude Code itself — the CLI *is* the control plane |
| **Code over config** | If you want new behavior, fork and change the code. OpenClaw gives you a plugin registry; MyClaw gives you the source |
| **Smaller channel surface** | Fewer channels, done well, vs. everything with adapters |

---

## Which one is right for what

| Use case | Better fit |
|---|---|
| You want your AI in WhatsApp, iMessage, and Discord simultaneously | OpenClaw |
| You want a team AI bot in Slack with business-grade permission controls | MyClaw |
| You want voice control ("Hey OpenClaw") | OpenClaw |
| You want to understand exactly how it works and modify it | MyClaw |
| You want a visual agent workspace (Canvas) | OpenClaw |
| You want deep Claude Code integration and skill-based customization | MyClaw |
| You're running it on a shared server with untrusted users | OpenClaw (Docker sandboxing) |
| You want advanced memory (consolidation, dreaming, dedup) | MyClaw |
| You want to swap to GPT-4 or Gemini | OpenClaw |
| You want it running in 10 minutes with minimal config | MyClaw |

---

## TL;DR

**OpenClaw** is what you build when you want AI everywhere — a platform with native apps, voice, visual interfaces, Docker isolation, and multi-provider support. It's designed to be deployed and used, not read.

**MyClaw** is what you build when you want AI that's *yours* — one small, readable codebase, deeply integrated with Claude Code, customized by changing the source. It's designed to be understood and shaped.

They share a lineage and a philosophy (self-hosted, messaging-first, persistent sessions), but they've evolved toward different audiences: OpenClaw toward power users who want a product, MyClaw toward developers who want a base.

---

## Request Flow Diagrams

How a single user message travels through each system end-to-end.

---

### OpenClaw — Full Request Flow

```
USER SENDS MESSAGE (e.g. WhatsApp)
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  CHANNEL ADAPTER  (src/whatsapp/, src/telegram/ …)  │
│                                                     │
│  • Baileys / grammY / discord.js receives WS event  │
│  • Extracts: text, media, sender, thread context    │
│  • Normalises to internal message format            │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  ACCESS CONTROL                                     │
│                                                     │
│  • Is sender on allowlist?                          │
│  • First-time DM? → send pairing code, block here  │
│  • Fails? → message dropped, nothing continues     │
└──────────────────────┬──────────────────────────────┘
                       │ passes
                       ▼
┌─────────────────────────────────────────────────────┐
│  GATEWAY  (src/gateway/server.ts)                   │
│  WebSocket server — single source of truth          │
│                                                     │
│  • Resolves session ID from sender+channel:         │
│      main           → operator, full host access    │
│      dm:<ch>:<id>   → sandboxed by default          │
│      group:<ch>:<id>→ sandboxed by default          │
│  • Dispatches to Agent Runtime                      │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  AGENT RUNTIME  (src/agents/piembeddedrunner.ts)    │
│                                                     │
│  Step 1 — SESSION LOAD                              │
│    Load ~/.openclaw/sessions/<id>.json from disk    │
│    (append-only event log, supports branching)      │
│                                                     │
│  Step 2 — CONTEXT ASSEMBLY                          │
│    Read AGENTS.md + SOUL.md + TOOLS.md              │
│    Inject relevant skills (SKILL.md files)          │
│    Query memory (SQLite + vector search) for        │
│    semantically similar past conversations          │
│    Build final system prompt                        │
│                                                     │
│  Step 3 — MODEL INVOCATION                          │
│    Stream to configured provider:                   │
│    Claude / GPT-4 / Gemini / local model            │
│    First token: ~200–500ms                          │
│                                                     │
│  Step 4 — TOOL EXECUTION LOOP                       │
│    Model requests tool → runtime intercepts         │
│    ┌─ main session:  runs on HOST directly          │
│    └─ dm/group:      runs inside DOCKER container   │
│         • isolated filesystem                       │
│         • network off by default                    │
│         • destroyed after turn                      │
│    Tool result streamed back into model             │
│    Loop continues until model stops calling tools   │
│                                                     │
│  Step 5 — STATE PERSISTENCE                         │
│    Append full turn (messages + tool calls +        │
│    results) to session JSON file                    │
│    Memory flush: promote durable facts to           │
│    MEMORY.md before compaction                      │
└──────────────────────┬──────────────────────────────┘
                       │ response chunks stream back
                       ▼
┌─────────────────────────────────────────────────────┐
│  RESPONSE DELIVERY                                  │
│                                                     │
│  • Gateway streams chunks to channel adapter        │
│  • Adapter formats for platform:                    │
│      WhatsApp markdown → WA bold/italic syntax      │
│      Discord → embed formatting                     │
│      Slack → mrkdwn                                 │
│  • Respects per-platform message size limits        │
│  • Typing indicators sent during generation         │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
              MESSAGE APPEARS FOR USER
```

**Latency breakdown (from article):**
- Access control: < 10ms
- Session load from disk: < 50ms
- Context assembly: < 100ms
- First token from model: 200–500ms
- Tool execution: 100ms (bash) to 1–3s (browser)

---

### MyClaw — Full Request Flow

```
USER SENDS MESSAGE (Slack or Telegram)
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  CHANNEL ADAPTER  (apps/core/src/channels/)         │
│  slack.ts / telegram.ts                             │
│                                                     │
│  Slack:    Bolt SDK via Socket Mode (WebSocket)     │
│  Telegram: polling loop every 2s                    │
│                                                     │
│  • Parses: text, files, thread_ts, sender           │
│  • Downloads file attachments → ./attachments/      │
│  • Enriches message with attachment paths           │
│  • Checks sender allowlist → drops if not allowed   │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  MESSAGE STORAGE  (apps/core/src/storage/db.ts)     │
│                                                     │
│  storeMessage() → SQLite messages table             │
│  Fields: id, chat_jid, sender, content,             │
│          timestamp, thread_id, reply context        │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  MESSAGE LOOP  (apps/core/src/runtime/message-loop) │
│                                                     │
│  Polls SQLite every 2 seconds for new messages      │
│  Compares against last-seen cursor per group        │
│  New messages found → triggers group queue          │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  GROUP QUEUE  (apps/core/src/runtime/group-queue)   │
│                                                     │
│  enqueueMessageCheck():                             │
│    • Slot free? → start processing immediately      │
│    • Slot busy? → set pendingMessages flag,         │
│                   process after current run         │
│  One active run per group at a time                 │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  GROUP PROCESSING  (runtime/group-processing.ts)    │
│                                                     │
│  Step 1 — ACKNOWLEDGMENT                            │
│    sendProgressUpdate("Working on it...") → Slack   │
│    Appears within ~500ms of message arrival         │
│                                                     │
│  Step 2 — PROMPT ASSEMBLY                           │
│    getNewMessages() → recent SQLite messages        │
│    formatMessages() → XML:                          │
│    <message sender="…" time="…">content</message>  │
│    Includes: text + attachment paths + thread ctx   │
│                                                     │
│  Step 3 — SPAWN AGENT                               │
│    spawnAgent() → new Node.js subprocess            │
│    Passes via stdin: prompt, sessionId, groupFolder,│
│    chatJid, permissionProfile, systemPrompt         │
└──────────────────────┬──────────────────────────────┘
                       │  subprocess stdin/stdout IPC
                       ▼
┌─────────────────────────────────────────────────────┐
│  AGENT RUNNER  (packages/agent-runner/src/index.ts) │
│  Separate Node.js process                           │
│                                                     │
│  Step 1 — STARTUP                                   │
│    Read config from stdin (JSON)                    │
│    Load session ID for conversation continuity      │
│    Start MCP stdio server (ipc-mcp-stdio.js)        │
│    for send_message / ask_user_question tools       │
│                                                     │
│  Step 2 — QUERY LOOP                                │
│    runQuery() → Claude Agent SDK query()            │
│                                                     │
│    for await (message of query({...})):             │
│      assistant message → silent (no streaming)      │
│      tool_call → execute tool:                      │
│        Bash, Read, Write, Edit — ON HOST (no Docker)│
│        WebSearch, WebFetch — direct                 │
│        mcp__myclaw__* → via IPC to main process     │
│      result → model sees tool output, continues     │
│      result message → writeOutput({result: text})   │
│                                                     │
│  Step 3 — IPC POLLING (during query)                │
│    Every 500ms: check data/ipc/<group>/input/       │
│    New message file? → push into active query stream│
│    _close file?     → end query, break loop         │
│                                                     │
│  Step 4 — COMPLETION                                │
│    writeOutput({result: null}) → session update     │
│    runAutomaticMemoryPass() → extract facts         │
│    waitForIpcMessage() → wait for next msg or close │
│    _close received → process.exit(0)                │
└──────────────────────┬──────────────────────────────┘
                       │ stdout: writeOutput() chunks
                       ▼
┌─────────────────────────────────────────────────────┐
│  BACK IN GROUP PROCESSING                           │
│                                                     │
│  outputChain processes each chunk:                  │
│                                                     │
│  result.result != null:                             │
│    formatOutboundForChannel() → Slack mrkdwn        │
│    channel.sendMessage() → single clean post        │
│    (no streaming, no "(edited)" markers)            │
│                                                     │
│  result.result == null (session update):            │
│    queue.notifyIdle()                               │
│    queue.closeStdin() → writes _close sentinel      │
│                                                     │
│  finally block:                                     │
│    sendProgressUpdate("Done in Xs.") if long task   │
│    queue slot released                              │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
              MESSAGE APPEARS FOR USER
              (single clean post, no edits)
```

**Latency breakdown (MyClaw):**
- Acknowledgment ("Working on it..."): ~500ms from message arrival
- SQLite poll cycle: up to 2s
- Agent runner spawn: ~100ms
- First Claude token: 200–800ms
- Tool execution: 100ms (file read) to 3s+ (web fetch)
- Final message post: single `chat.postMessage` call

---

### Side-by-side: Where the work happens at each layer

| Layer | OpenClaw | MyClaw |
|---|---|---|
| **Message receive** | Channel adapter → Gateway (WebSocket) | Channel adapter → SQLite directly |
| **Routing** | Gateway resolves session, dispatches | Message loop polls SQLite, group queue serialises |
| **Acknowledgment** | Typing indicator via adapter | `sendProgressUpdate("Working on it...")` |
| **Context build** | AGENTS.md + SOUL.md + skills + memory | XML-formatted messages + compiled system prompt |
| **Model call** | Pi Agent Core → any provider | Claude Agent SDK → Anthropic only |
| **Tool execution** | Host (main) or Docker (dm/group) | Host only, all sessions |
| **Tool auth** | Tool policy stack (7 layers) | Permission profile YAML per agent |
| **Streaming** | Chunk-by-chunk to channel | Silent during work, single post at end |
| **State save** | Append-only session JSON | SQLite messages + session transcript files |
| **Memory** | SQLite + vectors, auto-indexed | SQLite + vectors, with consolidation/dreaming |
| **Process exits** | Gateway stays alive indefinitely | Agent runner `process.exit(0)` after each turn |
