# MyClaw Webhooks — Clawdentity-Authenticated Job Trigger & Message Injection

**Status:** Draft
**Date:** 2026-04-16

---

## Design Decisions

- **Auth:** Clawdentity Ed25519 Proof of Possession (no shared secrets)
- **Response style:** Fire-and-forget (return job ID immediately)
- **Token scope:** Per-group (each group has its own allowed DIDs)

---

## 1. Webhook Auth Layer (Clawdentity PoP)

**Goal:** Verify incoming webhook requests using Clawdentity Ed25519 Proof of Possession — no shared secrets.

**New file:** `apps/core/src/mini-app/webhook-auth.ts`

**How it works:**
- Extract headers: `Authorization: Claw <AIT>`, `X-Claw-Proof`, `X-Claw-Timestamp`, `X-Claw-Nonce`, `X-Claw-Body-SHA256`
- Decode AIT JWT to get agent DID and public key
- Verify Ed25519 signature over `{method}|{path}|{timestamp}|{nonce}|{bodySha256}`
- Check timestamp within ±300s, reject replayed nonces
- Optionally validate agent DID against CRL (revocation list) from registry

**Per-group scoping:**
- New `settings.yaml` section under each group or in `message_policy`:
  ```yaml
  webhooks:
    telegram_kai-dev:
      allowed_dids: ["did:cdi:registry.clawdentity.com:agent:01HG..."]
    telegram_ops:
      allowed_dids: ["did:cdi:registry.clawdentity.com:agent:01HK..."]
  ```
- Request must include `X-Claw-Group: telegram_kai-dev` header
- Auth middleware checks if the agent's DID is in that group's `allowed_dids`

**Dependencies:** Import signing/verification utils from `~/workdir/clawdentity/packages/sdk` or vendor the Ed25519 verify function.

**Fallback consideration:** If Clawdentity infra isn't available, we could add a `WEBHOOK_FALLBACK_TOKEN` for dev/testing, but PoP is the primary path.

---

## 2. Webhook Route: Trigger Job

**Endpoint:** `POST /api/webhooks/jobs/trigger`

**New file:** `apps/core/src/mini-app/webhook-routes.ts`

**Two actions:**

**a) Trigger existing job:**
```json
{
  "action": "trigger",
  "job_id": "system:dreaming:telegram_kai-dev"
}
```
- Writes `scheduler_trigger_job` IPC task file
- Returns `{ ok: true, job_id: "...", run_id: "..." }` immediately (fire-and-forget)

**b) Create and run one-time job:**
```json
{
  "action": "once",
  "name": "External Task",
  "prompt": "Summarize today's messages",
  "deliver_to": ["tg:-1003687469956"],
  "timeout_ms": 300000
}
```
- Group scope derived from `X-Claw-Group` header (already validated by auth)
- Writes `scheduler_once` IPC task file
- Returns `{ ok: true, job_id: "generated-id" }` immediately

**Validation:**
- `action` must be `trigger` or `once`
- For `trigger`: `job_id` required, must exist, must belong to the authed group
- For `once`: `name` and `prompt` required
- Max `timeout_ms`: 600000 (10 min)

**Response:** Always async. Caller gets job ID back. Job output delivered to `deliver_to` sessions (Telegram chats).

---

## 3. Webhook Route: Send Message to Agent

**Endpoint:** `POST /api/webhooks/messages/send`

**Request:**
```json
{
  "text": "Hey, check if the deployment succeeded",
  "chat_jid": "tg:-1003687469956"
}
```
- Group derived from `X-Claw-Group` header

**Logic:**
1. Validate `chat_jid` belongs to the target group (query `registered_groups` table)
2. Check if there's an active agent session for this group:
   - **Active session exists:** Write to `$DATA_DIR/ipc/{groupFolder}/input/{id}.json` — agent's `pollIpcDuringQuery()` picks it up in ~500ms, message injected mid-conversation
   - **No active session:** Write to `$DATA_DIR/ipc/{groupFolder}/messages/{id}.json` — IPC watcher picks it up, triggers new agent spawn with the message as prompt
3. Return `{ ok: true, delivered: true, mode: "session" | "new" }`

**Session detection:**
- Need a helper to check if a group has an active running agent process
- Could check `$DATA_DIR/ipc/{groupFolder}/input/` existence + agent PID file, or add a lightweight session registry in the scheduler/message-loop

**Edge case:** If agent is mid-spawn (between process start and ready), queue the message — the input poll will catch it once ready.

---

## 4. Mini-App Server Changes

**File:** `apps/core/src/mini-app/server.ts`

**Changes:**
- Import and register webhook routes under `/api/webhooks/*` prefix
- Webhook routes use `webhook-auth` middleware (Clawdentity PoP), NOT Telegram auth
- Existing plan management routes stay on Telegram auth — no change

**Route registration:**
```typescript
// Existing
server.register(planRoutes, { prefix: '/api/plans' });

// New
server.register(webhookRoutes, { prefix: '/api/webhooks' });
```

**CORS:** Webhooks are server-to-server, so no CORS needed. Add `no-cors` for webhook prefix.

**Rate limiting:** Add per-DID rate limit (e.g., 60 req/min) using in-memory counter with TTL. Prevents abuse without external deps.

---

## 5. Settings & Config Changes

**settings.yaml — new `webhooks` section:**
```yaml
webhooks:
  enabled: true
  groups:
    telegram_kai-dev:
      allowed_dids:
        - "did:cdi:registry.clawdentity.com:agent:01HG8ZBU..."
    telegram_ops:
      allowed_dids:
        - "did:cdi:registry.clawdentity.com:agent:01HK9ABC..."
```

**Parsing changes:**
- `runtime-settings.ts` — add `webhooks` to `RuntimeSettings` interface and parser
- Validate: if `webhooks.enabled`, each group must be a registered group folder
- Validate: each DID must match `did:cdi:*` format

**.env additions:**
- `CLAWDENTITY_REGISTRY_URL` — registry URL for CRL fetch (optional, for revocation checking)
- `WEBHOOK_NONCE_TTL_MS` — nonce replay window (default 600000)

**config.ts:**
- Add `CLAWDENTITY_REGISTRY_URL` and `WEBHOOK_NONCE_TTL_MS` to config constants

---

## 6. Files Summary & Dependencies

**New files:**

| File | Purpose |
|------|---------|
| `apps/core/src/mini-app/webhook-auth.ts` | Clawdentity PoP verification middleware |
| `apps/core/src/mini-app/webhook-routes.ts` | Both webhook route handlers |
| `apps/core/src/mini-app/nonce-cache.ts` | In-memory nonce replay prevention |

**Modified files:**

| File | Change |
|------|--------|
| `apps/core/src/mini-app/server.ts` | Register webhook routes |
| `apps/core/src/cli/runtime-settings.ts` | Parse + validate `webhooks` section |
| `apps/core/src/core/config.ts` | Add webhook config constants |
| `.env.example` | Add `CLAWDENTITY_REGISTRY_URL` |

**Dependencies:**
- Ed25519 verify: use `@noble/ed25519` (already a transitive dep via Clawdentity SDK) or vendor from `~/workdir/clawdentity/packages/sdk/src/crypto/`
- JWT decode: lightweight AIT decode (no full JWT lib needed — just base64url split + JSON parse, signature already verified via PoP)
- No new npm packages required if we vendor the crypto utils

**Testing:**
- Unit tests for webhook-auth (mock Ed25519 keypair, sign requests, verify)
- Unit tests for webhook-routes (mock IPC writes, verify file contents)
- Integration test: full request → IPC file → scheduler pickup
