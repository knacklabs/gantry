# /autoplan Restore Point
Captured: 2026-04-17T12:43:56Z | Branch: codex-memory-real-facts | Commit: 6f5db8b

## Re-run Instructions
1. Copy "Original Plan State" below back to your plan file
2. Invoke /autoplan

## Original Plan State
# Revamp chat management, memory scoping, and access control for MyClaw

## Context

MyClaw currently treats every chat as a "registered group" — a flat list of `(jid, folder, trigger_pattern, allowlist)` rows keyed by Telegram chat ID or Slack channel ID. This worked when every chat was a single group bound to one agent. It's breaking down now because:

1. **Memory is rigidly scoped to one group_folder.** Two Slack channels owned by the same team cannot share memory. One Telegram group and one Slack channel running the same agent can't share context. The `_global` and `user_id` memory scopes exist in the schema (`apps/core/src/memory/memory-types.ts:1-2`, `:17`) but aren't surfaced at retrieval time.
2. **DMs have no first-class support.** A Telegram DM or Slack IM would have to be manually registered via `myclaw group add` with a made-up folder. No auto-registration. No per-user gating.
3. **The allowlist is flat.** `ChatAllowlistEntry = { allow: '*' | string[], mode: 'trigger' | 'drop' }` (`apps/core/src/cli/runtime-settings.ts:13-16`) — no admins, no "open to everyone, gated by pairing code", no per-user policy.
4. **Session scope is hard-coded to `group_folder`.** One session per folder (`apps/core/src/storage/db.ts:248-251`). If two chats share a folder (shared agent pool), they overwrite each other. If a group wants per-user threads, no knob exists.

**Intended outcome:** a policy-driven chat model where per-chat (or default) config declares (a) who can message, (b) which memory pool the chat draws from / writes to, and (c) how sessions are scoped. DMs auto-register with a pairing flow (hermes-style). Groups and channels get a unified access model (open / trigger / allowlist / pair). Memory can be private-per-chat, shared across a named pool, or agent-global — chosen per chat.

This captures strong opinions from three sibling codebases:
- **OpenClaw** — hierarchical session keys (`agent:{agentId}:{rest}`), `DmScope` enum (`main | per-peer | per-channel-peer | per-account-channel-peer`), allowlist fallback (`direct → parent → wildcard`) with `matchSource` audit.
- **Hermes** — pairing codes for DMs (8-char unambiguous alphabet, rate-limited, owner-approved via CLI), per-platform / per-chat-type reset policies, frozen memory snapshot at session start.
- **MyClaw** — solid per-group filesystem isolation, working trigger pattern, memory schema already has the `user_id` + `scope` fields we need (just unused).

---

## The design (strong opinion)

### One primitive: the **Chat Policy**

Every chat (group, channel, DM, thread) has three orthogonal knobs, each independently defaultable and overridable:

| Axis | Values | Default |
|---|---|---|
| **access** | `open` / `trigger` / `allowlist` / `pair` | `trigger` for groups, `pair` for DMs |
| **memory_binding** | `private` / `pool:<name>` / `agent` | `private` (per-chat) |
| **session_scope** | `chat` / `chat+user` / `thread` / `user` | `chat` for groups, `user` for DMs |

These three axes are the whole model. Everything else (admins, reset policy, trigger regex) is a secondary knob.

### Memory pools — the feature the user asked for

Today memory is keyed by `(scope, group_folder, user_id)`. We keep that but add `pool_id`. At retrieval, the effective memory set for a running chat is:

```
effective_memory(chat) =
    agent_global(chat.group_folder)        // scope='agent'   (renamed from 'global')
  ∪ pool(chat.memory_binding)              // scope='pool'    (new)
  ∪ chat_private(chat.jid)                 // scope='chat'    (renamed from 'group')
  ∪ user(current_user_id)                  // scope='user'    (existing, now actually surfaced)
```

**The three shapes the user asked for fall out naturally:**
- *Shared across groups/channels* → bind multiple chats to `pool:team-eng`
- *Dedicated per chat* → leave `memory_binding = private` (the default)
- *Global across all chats of an agent* → bind to `agent`

### Access control — one enum, four modes

Replaces `ChatAllowlistEntry` entirely.

```ts
type ChatAccess =
  | { mode: 'open' }                                 // anyone, no @mention required
  | { mode: 'trigger' }                              // anyone, must @mention bot (current group default)
  | { mode: 'allowlist'; allow: string[] }           // only these user IDs
  | { mode: 'pair'; pairing: PairingConfig };        // unknown → pairing code flow

type ChatPolicy = {
  access: ChatAccess;
  admins: string[];                   // can run /compact /new /model regardless of chat
  deny_action: 'silent' | 'hint';     // silent drop or reply-with-pair-instructions
  memory_binding: 'private' | { pool: string } | 'agent';
  session_scope: 'chat' | 'chat+user' | 'thread' | 'user';
  trigger?: string;                   // override trigger regex per chat
};
```

**DM access** gets two policy-level defaults (`access.dm.default`) — the user's requested "anyone can chat OR allowlist" is just `mode: open` vs `mode: allowlist | pair`.

### Pairing flow (stolen almost verbatim from hermes)

Unknown user DMs the bot. Bot replies: `👋 You're not paired yet. Ask the owner to run: myclaw dm approve tg ABC23456`. Code is 8 chars from a 32-char unambiguous alphabet (no `0/O/1/I`), 1-hour TTL, rate-limited (1 request per user per 10 min, max 3 pending per platform). Owner runs the CLI, user is now in `approved_users` and can message freely.

Same flow applies to **groups** when access=`pair` — the chat becomes auto-joinable after an owner approves the code. This answers the user's "DM giving access to individual users like anyone can chat or allowlist can chat including groups as well".

### Session key — OpenClaw format

```
agent:{group_folder}:{platform}:{chat_type}:{native_id}[:thread_id][:user_id]
```

`thread_id` and `user_id` are appended per `session_scope`. This replaces `sessions.group_folder` (PK) → `sessions.session_key` (PK), with a lookup index by group_folder for backward compat.

### Config shape — `settings.yaml` v2

```yaml
access:
  dm:
    default:
      mode: pair            # open | allowlist | pair
      deny_action: hint
      pairing: { ttl_hours: 1, rate_limit_minutes: 10 }
  groups:
    default:
      mode: trigger         # open | trigger | allowlist | pair
      deny_action: silent
      admins: []
    overrides:
      "tg:-1001234":
        mode: open
        memory_binding: { pool: family }
        session_scope: chat
      "sl:C02ENG001":
        mode: allowlist
        allow: ["U01ABC", "U01DEF"]
        admins: ["U01ABC"]
        memory_binding: { pool: team-eng }

memory:
  pools:
    team-eng: { description: "Engineering channels + Slack DMs with eng team" }
    family:   { description: "Family Telegram" }
  # No explicit bindings block needed — bindings live inside each chat policy above.

sessions:
  default_scope: chat
  dm_scope: user
  reset:
    dm: { mode: idle, idle_minutes: 120 }
    groups: { mode: none }
```

---

## Data model changes

### Schema (SQLite, `apps/core/src/storage/db.ts`)

```sql
-- Extend registered_groups (keep name for now; rename to registered_chats in a later pass)
ALTER TABLE registered_groups ADD COLUMN chat_type TEXT DEFAULT 'group';     -- group|channel|dm|thread
ALTER TABLE registered_groups ADD COLUMN policy_json TEXT;                   -- serialized ChatPolicy override; NULL = use defaults

-- Memory pools (new)
CREATE TABLE memory_pools (
  id           TEXT PRIMARY KEY,      -- short slug: 'team-eng'
  description  TEXT,
  created_at   TEXT NOT NULL
);

-- Pool-scoped memory columns (new)
ALTER TABLE memory_items     ADD COLUMN pool_id TEXT NULL REFERENCES memory_pools(id);
ALTER TABLE memory_procedures ADD COLUMN pool_id TEXT NULL REFERENCES memory_pools(id);
ALTER TABLE memory_chunks    ADD COLUMN pool_id TEXT NULL REFERENCES memory_pools(id);
CREATE INDEX idx_memory_items_pool ON memory_items(pool_id) WHERE pool_id IS NOT NULL;

-- Pairing (new)
CREATE TABLE pairing_codes (
  code         TEXT PRIMARY KEY,
  platform     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  user_name    TEXT,
  requested_in_chat TEXT,              -- for pair-to-join groups
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE TABLE approved_users (
  platform     TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  user_name    TEXT,
  approved_by  TEXT,
  approved_at  INTEGER NOT NULL,
  PRIMARY KEY (platform, user_id)
);
CREATE TABLE pairing_rate_limits (
  platform          TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  last_request_at   INTEGER NOT NULL,
  failed_attempts   INTEGER DEFAULT 0,
  PRIMARY KEY (platform, user_id)
);

-- Sessions: widen to support new scope
ALTER TABLE sessions ADD COLUMN session_key TEXT;  -- new canonical key; group_folder stays as secondary index
CREATE INDEX idx_sessions_key ON sessions(session_key);
```

### Memory scope enum revamp

In [memory-types.ts:1](apps/core/src/memory/memory-types.ts:1):

```ts
export type MemoryScope = 'user' | 'chat' | 'pool' | 'agent';
// Migration: old 'group' → 'chat'; old 'global' → 'agent'; 'user' unchanged.
// One-time DB UPDATE on startup + alias the old names in the write path during a grace period.
```

---

## Critical files to modify

**New:**
- `apps/core/src/platform/chat-policy.ts` — unified `ChatPolicy` type + resolver (overrides → defaults fallback). Reuses the hierarchical pattern from [openclaw channel-config.ts:82-164](~/workdir/openclaw/src/channels/channel-config.ts:82).
- `apps/core/src/platform/pairing.ts` — code generation (`crypto.randomBytes` + 32-char alphabet), TTL, rate limit, approval store. Port of [hermes pairing.py:128-168](~/workdir/hermes-agent/gateway/pairing.py:128).
- `apps/core/src/platform/session-key.ts` — builds `agent:{folder}:{platform}:{chat_type}:{native}[:thread][:user]`. Port of [hermes build_session_key](~/workdir/hermes-agent/gateway/session.py:422).
- `apps/core/src/memory/memory-pools.ts` — pool CRUD + chat-binding resolution at retrieval time.
- `apps/core/src/cli/dm.ts` — `myclaw dm approve|revoke|list|pending`.
- `apps/core/src/cli/pool.ts` — `myclaw pool create|bind|list`.

**Modified:**
- [apps/core/src/memory/memory-types.ts](apps/core/src/memory/memory-types.ts:1) — new scope enum, `pool_id` field on items/procedures/chunks.
- [apps/core/src/memory/memory-store.ts](apps/core/src/memory/memory-store.ts) — pool-aware write and retrieval.
- [apps/core/src/memory/memory-retrieval.ts](apps/core/src/memory/memory-retrieval.ts) — union across (agent, bound pools, chat, user).
- [apps/core/src/storage/db.ts](apps/core/src/storage/db.ts:248) — new tables + migrations guarded by `addColumnIfMissing`.
- [apps/core/src/cli/runtime-settings.ts](apps/core/src/cli/runtime-settings.ts:13) — v2 schema parser. **The custom YAML parser here (lines 167-211) is strict about 2-space indent and no tabs — the new schema must fit it, or we adopt a real YAML lib (recommend `yaml` package, ~30kb).**
- [apps/core/src/platform/sender-allowlist.ts](apps/core/src/platform/sender-allowlist.ts) — becomes a thin compat shim that reads the new `ChatPolicy` and answers the old `isSenderAllowed` API. Deprecate after two releases.
- [apps/core/src/channels/telegram.ts](apps/core/src/channels/telegram.ts) / [slack.ts](apps/core/src/channels/slack.ts) — detect `chat_type='dm'` on inbound, auto-register with default DM policy, dispatch pairing reply on `pair` deny.
- [apps/core/src/runtime/message-loop.ts](apps/core/src/runtime/message-loop.ts:117) — replace the allowlist-and-trigger gate with a `resolveChatPolicy(chat) → gateMessage(policy, msg)` call that also returns the resolved `session_key` + `memory_binding`.
- [apps/core/src/bootstrap/runtime-app.ts](apps/core/src/bootstrap/runtime-app.ts:106) — load sessions by `session_key`, not `group_folder`.
- [apps/core/src/runtime/group-processing.ts](apps/core/src/runtime/group-processing.ts:124) — pass `memory_binding` + `session_key` into `runAgent`; memory retrieval loads the effective union.

---

## Migration strategy (backward-compatible)

1. **Schema:** `ALTER TABLE ... ADD COLUMN` never fails; each new table is `CREATE IF NOT EXISTS`. No data loss.
2. **Memory scope rename:** on startup, `UPDATE memory_items SET scope='chat' WHERE scope='group'; UPDATE ... SET scope='agent' WHERE scope='global'`. Idempotent. Write path accepts both old and new names during a 2-release grace window, then drops the aliases.
3. **Settings.yaml:** keep `channels.telegram.sender_allowlist` parsing working as a legacy path — when present and the new `access:` block is absent, translate old → new at load time. Warn once. Remove after two releases.
4. **Sessions:** existing rows get `session_key = 'agent:{folder}:legacy'` on migration — the message loop then re-hydrates them under the new key on first message. No loss.
5. **DMs:** existing DMs that were manually registered as groups keep working. First-time unknown DMs now get the pairing flow instead of being silently rejected by the default `*`→trigger policy.

---

## What I'm deliberately NOT doing (yet)

These came up in the exploration but don't belong in this cut:

- **Vector embeddings across pools** — `memory_embeddings.ts` exists but cross-pool semantic search is a separate problem. Pool binding is lexical now; embedding join comes later.
- **Discord / WhatsApp / Signal** — hermes supports them; myclaw doesn't. Not in scope.
- **Dreaming cron** — openclaw has a dreaming refresh on a cron schedule. Current myclaw dreaming fires per-message; keep as-is.
- **Per-chat model override** — `registered_groups.container_config` exists (line 258 of db.ts) but exposing it via chat policy is a follow-up.
- **Schema migration versioning** — using `addColumnIfMissing` for now; a proper `schema_version` table can come when we actually need to rename tables.

---

## Verification

**Unit tests:**
- [ ] `chat-policy.test.ts` — resolver fallback (override → channel default → global default → hardcoded default), matchSource audit logs.
- [ ] `pairing.test.ts` — code generation uniqueness, TTL expiry, rate-limit enforcement, approval state machine.
- [ ] `session-key.test.ts` — 4 scope variants produce distinct keys; round-trip parse.
- [ ] `memory-pools.test.ts` — write to pool from chat A, read from chat B bound to same pool.
- [ ] `memory-retrieval.test.ts` — effective set = union across scopes in correct precedence.

**Integration tests:**
- [ ] Unknown Telegram DM → bot sends pair hint → `myclaw dm approve tg CODE` → next message from same user routes to agent.
- [ ] Two Slack channels bound to `pool:team-eng` — memory saved in channel A surfaces in agent prompt in channel B.
- [ ] Existing group with `sender_allowlist` config still gates messages identically (legacy path).
- [ ] Rate limit: 2 pair requests from same user within 10 min — second is rejected.

**E2E smoke:**
- [ ] Fresh install, no settings.yaml → defaults take effect (groups require trigger, DMs require pair).
- [ ] Migration: existing myclaw instance with registered groups and memory — after upgrade, all existing flows still work; `myclaw pool create team-eng && myclaw pool bind sl:C01 team-eng` enables sharing.

**Commands to run:**
```bash
npm run build
npm test -- --testPathPattern='(chat-policy|pairing|session-key|memory-pools|memory-retrieval)'
# manual: restart daemon, send DM from unknown user, observe pair hint reply
launchctl kickstart -k gui/$(id -u)/com.myclaw
```

---

## Open questions for the user (only if you want to deviate from the opinion)

The plan above is my recommendation. I'd run autoplan's CEO/eng/DX review gauntlet on it as a follow-up — but the gauntlet is ~30 minutes of heavy codex + subagent calls and burns cache, so it's better done *after* you've confirmed the direction. If the direction is right, say "go" and I'll run autoplan against this plan file. If you want to change anything first, the biggest decision points are:

1. **Pair-to-join for groups, not just DMs?** I argued yes (symmetry). The alternative is DMs-only pair, groups stay on allowlist/trigger.
2. **Keep `sender_allowlist` legacy path for 2 releases, or cut immediately?** I recommend keep — it's ~50 lines of translation code for a much smoother upgrade.
3. **Thread-scoped sessions?** I put it in the enum (`session_scope: 'thread'`) but didn't wire per-channel thread detection into the message loop. Fine as a follow-up, or include now?

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**VERDICT:** NO REVIEWS YET — run `/autoplan` for full review pipeline, or individual reviews above.
