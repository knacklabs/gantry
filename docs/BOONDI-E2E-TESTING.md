# Boondi E2E Testing Runbook

How to drive and test Boondi (the Bombay Sweet Shop WhatsApp agent) locally by
mimicking Interakt. Written for a Claude session that is asked "test scenario X"
— every claim below was verified against code or a live run on 2026-06-10
(branch `feat/interakt-shopify`). File:line refs are re-checkable.

Repo: `/Users/caw-d/Desktop/gantry` · Runtime home: `/Users/caw-d/gantry`
(`GANTRY_HOME`). Agent files under `~/gantry/agents/boondi_support/` are
symlinks into the repo's `agents/boondi_support/` — repo edits are live after a
core restart.

**Standing rules from the operator — follow these whenever working on
Gantry/Boondi:**

1. **Dev mode only — never launchd.** Every server runs plain `npm run dev`,
   driven by the `.env` in the gantry runtime folder (§3).
2. **Cluttered state? Take the fresh start.** When old sessions/backlogs/DB
   noise get in the way, wipe everything with
   `bash ops/reset-runtime/reset-gantry-runtime.sh --yes` — it preserves the
   Claude OAuth token automatically — then kill + restart the dev stack (§8).
3. **Edit `~/gantry/settings.yaml` directly** to adjust and test
   (idle timings, guardrail mode/model, thinking, …) — restart core to apply.
4. **Confused while debugging? Read the logs first** — `GANTRY_FLOW_LOG=1` and
   the `flow:` events trace every message through the pipeline (§9).
5. **Maintain a clear boundary between Boondi and Gantry in every change.**
   Gantry (`apps/core`, channel adapters, the plugin/command/skill registries)
   is the generic runtime and stays agent-agnostic — never hardcode Boondi
   names, phones, prompts, or business logic into it. Boondi lives in its own
   layer: `agents/boondi_support/*` (SOUL/CLAUDE/guardrails/commands/skills),
   its `agents.boondi_support` block in settings.yaml, the `packages/mcp-crm`
   and `packages/mcp-shopify` services, and the boondi-admin repo. Boondi-side
   plugin files stay self-contained with no imports from core (the existing
   pattern in `guardrails/guardrail.ts` and `commands/extract-leads-queries.ts`
   — context types declared locally), and any core change must make sense for
   ANY agent, not just Boondi.

---

## 1. The pipeline at a glance

```
WhatsApp customer
   │  (real traffic arrives via ngrok → Interakt webhook)
   ▼
POST /v1/channels/interakt/webhook            core :4710
   │  HMAC signature gate (INTERAKT_WEBHOOK_SECRET)
   ▼
Guardrail (pre-agent, in core)                agents/boondi_support/guardrails/guardrail.ts
   │  deterministic regex stage → allow | direct_response (canned reply, no agent)
   │  unresolved allowed turns fall through to Boondi with inline scope guardrail
   ▼
Agent run (Claude Agent SDK)                  prompts: SOUL.md + CLAUDE.md (synced at BOOT)
   │  mcp_call_tool → file-IPC → host proxy (X-Caller-Identity HMAC)
   ├──► shopify-api  :8081   (packages/mcp-shopify)
   └──► boondi-crm   :8082   (packages/mcp-crm — get_open_records only)
   ▼
Outbound reply
   │  GANTRY_OUTBOUND_DRYRUN × GANTRY_TEST_OPERATOR_PHONE gate
   ├──► Interakt send API (only when allowed)
   └──► ALWAYS persisted → gantry.messages / message_parts
   ▼
boondi-admin :3000  (read-only viewer — THE proof of record)

Background (after the conversation goes idle):
   idle sweep → session-end digest (gantry.agent_session_digests)
     ├──► core memory-fact extraction → gantry.memory_items
     └──► mcp-crm digest-watcher → lead/query extraction
            → boondi_crm.boondi_business_records
   nightly dreaming consolidation (cron 0 1 * * *)
```

---

## 2. Safety rails — the two dev variables (NEVER skip this section)

Both live in `~/gantry/.env` (§9 "DEV / TEST FLAGS"), are hydrated into the
process at **startup** (restart core to apply), and are compared as the raw
string `"1"` — keep them a bare `1` with no trailing comment.

### `GANTRY_OUTBOUND_DRYRUN` (.env ~line 191)

Code: `apps/core/src/app/bootstrap/channel-wiring.ts:346`.

| DRYRUN    | number in operator list? | what happens to Boondi's reply                                                                   |
| --------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `1`       | yes — real number        | **real Interakt send attempted** → actually delivers (self-routed x→x)                           |
| `1`       | yes — fake number        | real send attempted → accepted-then-fails (or errors) at the provider; **reply still persisted** |
| `1`       | no                       | **never sent at all**, reply persisted only                                                      |
| `0`/unset | (irrelevant)             | **production: sends to every customer**                                                          |

Every reply is persisted to `gantry.messages` regardless — that is why tests
are visible in boondi-admin even when nothing is sent.

### `GANTRY_TEST_OPERATOR_PHONE` (.env ~line 195)

Code: `apps/core/src/shared/test-mode.ts` (digits-only, comma/space separated,
deduped). It does **not** gate inbound — any number's message gets processed.
It gates two things:

1. which numbers outbound may actually be sent to under dry-run (table above);
2. the **session-command allowance** — only listed numbers may run slash
   commands (`/new`, `/digest-session`, `/extract-leads-queries`, …).

Current list: `919654405340` (operator's REAL WhatsApp — replies to it
actually deliver) plus fake pools `000000001–000000059` and
`000000901–000000906`. Special fakes: `000000050` is the seeded "returning
customer" persona; `000000901–906` are the isolation-suite pool;
`000000001–003` are fallback lane phones (`scripts/lib/phones.mjs`).

### `GANTRY_TEST_CALLER_IDENTITY_PHONE=918097288633` (.env ~line 209)

Remaps the signed Shopify caller identity of every turn to a customer that has
real Shopify data (the per-call swap lives in core's IPC admin handlers). CRM
capture is immune — it keys off the **conversation** phone, never this header.

**Rules: (a) never set `GANTRY_OUTBOUND_DRYRUN=0` during testing; (b) always
send test traffic from a FAKE listed number, never the real one unless the
user explicitly wants a message on their phone; (c) editing
`~/gantry/settings.yaml` and the `.env` dev flags directly is allowed and
expected for test adjustments (recorded as the "Dev-mode exception" in repo
`CLAUDE.md`) — both are read at core start, so restart core after editing; (d) confirm flags on the LIVE process, not just the file:**

```bash
ps -wwE -o args= -p $(lsof -ti tcp:4710 -sTCP:LISTEN) | tr ' ' '\n' | grep -E '^GANTRY_(OUTBOUND_DRYRUN|TEST_OPERATOR_PHONE)='
```

---

## 3. Service topology and health checks

| Port | Service                                 | Source                                   | Health check                                                                          |
| ---- | --------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| 4710 | gantry core (webhook receiver)          | `apps/core/src/index.ts`                 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4710/` (any HTTP code ≠ 000) |
| 8081 | shopify-api MCP                         | `packages/mcp-shopify/src/index.ts`      | `curl -s http://127.0.0.1:8081/healthz` → `{"ok":true}`                               |
| 8082 | boondi-crm MCP + digest watcher         | `packages/mcp-crm/src/index.ts`          | `curl -s http://127.0.0.1:8082/healthz` → `{"ok":true}`                               |
| 3000 | boondi-admin panel                      | `~/Desktop/boondi-admin` (separate repo) | `curl -s http://localhost:3000/api/conversations`                                     |
| 4040 | ngrok inspector (real Interakt traffic) | `ngrok http 4710`                        | `curl -s http://127.0.0.1:4040/api/tunnels`                                           |

Quick "what's running": `for p in 4710 8081 8082 3000 4040; do lsof -ti tcp:$p -sTCP:LISTEN >/dev/null && echo "$p up" || echo "$p DOWN"; done`

**The stack runs in dev mode ONLY — never start or rely on launchd**
(`com.gantry`). Every server is `npm run dev`-style (tsx, live source) and
reads its config/secrets from `~/gantry/.env`: core hydrates the §2 dev flags
from that file at startup (an explicit env on the launch command still wins),
and both MCPs self-load it. If port 4710 is ever held by a stale launchd job
(`launchctl list | grep gantry`), clear it once with
`launchctl bootout gui/$(id -u)/com.gantry` — but never start Gantry that way.

### Killing the gantry server (run before any restart — no thinking required)

```bash
pkill -f "apps/core/src/index.ts" 2>/dev/null; pkill -f "packages/mcp-crm/src/index.ts" 2>/dev/null; pkill -f "packages/mcp-shopify/src/index.ts" 2>/dev/null; sleep 1
for port in 4710 8081; do
  lsof -ti tcp:$port -sTCP:LISTEN | while read -r p; do kill -9 "$p"; done
done
lsof -ti tcp:4710 -sTCP:LISTEN >/dev/null 2>&1 \
  && echo "4710 STILL HELD — stale launchd job? launchctl bootout gui/$(id -u)/com.gantry" \
  || echo "gantry core down, 4710 free"
lsof -ti tcp:8081 -sTCP:LISTEN >/dev/null 2>&1 \
  && echo "8081 STILL HELD — stale shopify MCP?" \
  || echo "shopify MCP down, 8081 free"
```

Kills core + boondi-crm + shopify (127.0.0.1) and force-frees :4710 and :8081
(orphaned cores double-process every message — never run two). Shopify on :8081
can usually stay up across a DB reset; this snippet now clears it too for a full
stop.

### Starting the stack (dev mode)

**Always plain `npm run dev`, one per server, driven entirely by
`~/gantry/.env`** — core hydrates the §2 dev/test flags from that file at
startup and the MCPs self-load it, so nothing is passed on the command line:

```bash
cd /Users/caw-d/Desktop/gantry
npm run dev                                  # core       :4710
(cd packages/mcp-shopify && npm run dev)     # shopify    :8081
(cd packages/mcp-crm     && npm run dev)     # boondi-crm :8082
(cd ~/Desktop/boondi-admin && npm run dev)   # admin panel:3000
```

Each runs in its own terminal, or background it with
`npm run dev > /tmp/<name>-dev.log 2>&1 &`. Adjusting a flag = edit
`~/gantry/.env`, then kill + `npm run dev` again.

Gotchas (will bite if ignored):

- **One core at a time** — use the kill block above before starting.
- **Launching from a Claude Code shell only:** the harness injects
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`, and core's preflight rejects
  `ANTHROPIC_BASE_URL` — prefix with
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_OAUTH_TOKEN npm run dev`.
  A normal user terminal needs nothing.
- **Regression-harness runs only** (§8): the harness parses core's flow log
  from a file, so start core as
  `npm run dev > "${GANTRY_DEV_LOG:-/tmp/gantry-dev.log}" 2>&1 &` and with a
  short `IDLE_TIMEOUT=2500` (default is 30 min —
  `apps/core/src/config/index.ts:411` — and warm LLM runs fill the active-run
  slots, making later fake-phone chats appear unanswered).
  For warm-follow-up latency measurements, use a bounded realistic window such
  as `BOONDI_TEST_IDLE_TIMEOUT_MS=20000 scripts/boondi-test-setup.sh`, otherwise
  the short regression-suite timeout forces SDK-session resume instead of
  measuring the in-process `MessageStream` path.
  `scripts/boondi-test-setup.sh` exists to set up exactly that shape for
  harness runs; it is not the normal way to start the stack.

---

## 4. Mimicking Interakt — the webhook

Route: `POST http://127.0.0.1:4710/v1/channels/interakt/webhook`
(`apps/core/src/control/server/routes/interakt-webhook.ts`).

Auth: HMAC-SHA256 of the **exact raw body bytes** with
`INTERAKT_WEBHOOK_SECRET` (from `~/gantry/.env`), sent as
`Interakt-Signature: sha256=<hex>` (`X-Interakt-Signature` also accepted;
timing-safe compare; no bypass).

Responses: `200 {"ok":true}` = signature OK + **ACK only** (processing is
async after the ACK — a 200 does NOT mean a reply will come) · `401` bad
signature · `400` malformed body · `405` non-POST · `503` Interakt channel not
connected. Body cap 64 KiB.

A payload is processed as a customer message **only if all of these hold**
(`apps/core/src/channels/interakt/channel.ts`):

- `type == "message_received"` — everything else (`message_api_sent` /
  `delivered` / `read` status callbacks) is ACKed and dropped;
- `data.message.chat_message_type == "CustomerMessage"` — `BusinessMessage`
  (our own outbound echo) is dropped;
- `data.message.message_content_type == "Text"` — media is not supported;
- `data.customer.channel_phone_number` present (digits, no `+`) — this becomes
  the conversation id `conversation:wa:<phone>`.

Dedup: `data.message.id` is unique per conversation — re-sending the same id
ACKs 200 but is dropped at the DB constraint. Use a fresh UUID per message
(omit it and core synthesizes one).

### Preferred sender — `scripts/lib/webhook.mjs` (canonical, allowlist-guarded)

```bash
cd /Users/caw-d/Desktop/gantry
node -e 'import("./scripts/lib/webhook.mjs").then(async m => {
  const r = await m.sendWebhook({ text: "Do you have kaju katli?", from: "000000905", name: "Test Customer" });
  console.log(JSON.stringify(r));
})'
# → {"status":200,"ok":true,"messageId":"<uuid>","chatJid":"wa:000000905","response":"{\"ok\":true}\n"}
```

It builds the minimal valid payload, signs the exact bytes, and **refuses
`from` numbers not in `GANTRY_TEST_OPERATOR_PHONE`** (safety convention — the
runtime itself would process any number but could never reply to an unlisted
one under dry-run, which just wastes an LLM turn).

### Raw curl equivalent (tested verbatim)

```bash
SECRET=$(grep '^INTERAKT_WEBHOOK_SECRET=' ~/gantry/.env | cut -d= -f2-)
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000000)
MSGID=$(uuidgen | tr 'A-Z' 'a-z')
BODY='{"version":"1.0","timestamp":"'$NOW'","type":"message_received","data":{"customer":{"channel_phone_number":"000000904","traits":{"name":"Curl Test"}},"message":{"id":"'$MSGID'","chat_message_type":"CustomerMessage","message_content_type":"Text","message":"hi","received_at_utc":"'$NOW'"}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
curl -s -X POST http://127.0.0.1:4710/v1/channels/interakt/webhook \
  -H "Content-Type: application/json" \
  -H "Interakt-Signature: sha256=$SIG" \
  --data-binary "$BODY"
```

Change `channel_phone_number`, `message`, and (optionally) `traits.name` per
turn; everything else stays. Always `--data-binary` — the signature covers the
exact bytes.

A real captured Interakt payload carries more fields (customer `id`, `traits`
with `whatsapp_opted_in`/`chat_assignee`, message `message_status`,
`received_at_utc`, `data.channel_type:"Whatsapp"`, …) — none of the extras are
required. To inspect live traffic: ngrok UI at `http://127.0.0.1:4040` or
`curl -s "http://127.0.0.1:4040/api/requests/http?limit=20"` (the `raw` field
is base64 of the full HTTP request). The public tunnel URL changes when ngrok
restarts; Interakt's webhook config must point at the current one.

---

## 5. Reading the reply — poll every 5 s

Boondi talks to LLMs and is slow. Observed timings (2026-06-10): deterministic
guardrail reply **0.7 s**; agent turn with one Shopify lookup **21 s**;
`/extract-leads-queries` ack ~1 s + stats reply ~85 s after an LLM extraction.
Budget — **poll every 5 s and proceed as soon as the reply lands**:

- **simple chat turn: 50 s at most** — nothing by then ⇒ stop waiting and
  debug (§9);
- **slash-command replies (extraction stats etc.): 2 minutes at most** —
  nothing by then ⇒ debug. (The command's own `timeoutMs` is 150 s in
  `agents/boondi_support/commands/extract-leads-queries.ts`, so a straggler
  "timed out" reply can still appear after you've moved on to debugging.)

### Poll target 1 — admin API (preferred; works whenever :3000 is up)

```bash
curl -s "http://localhost:3000/api/messages?conversationId=conversation:wa:000000905" | python3 -c "
import json,sys
for m in json.load(sys.stdin)['messages']:
    print(f\"[{m['createdAt']}] {m['direction']:8} | {m['deliveryStatus'] or '-':6} | {m['text'][:110]}\")"
```

A new `outbound` row newer than your send = the reply. `deliveryStatus` is
`sent`/`failed` — for fake numbers either can appear (provider may accept the
API call and fail delivery async); **the transcript text is the test result,
not the delivery status.**

### Poll target 2 — SQL (when the admin panel is down)

`GANTRY_DATABASE_URL` in `~/gantry/.env` has a `?schema=gantry` suffix that
psql rejects — strip it:

```bash
DBURL=$(grep '^GANTRY_DATABASE_URL=' ~/gantry/.env | cut -d= -f2- | sed 's/?.*//')
psql "$DBURL" -At -F' | ' -c "
SELECT m.created_at, m.direction, m.delivery_status,
       left((SELECT string_agg(p.payload_json->>'text','' ORDER BY p.ordinal)
             FROM gantry.message_parts p WHERE p.message_id=m.id), 120)
FROM gantry.messages m
WHERE m.conversation_id='conversation:wa:000000905'
ORDER BY m.created_at;"
```

Do **not** poll `gantry.outbound_deliveries` / `outbound_delivery_final_answers`
— verified empty on this branch; replies live in `messages` + `message_parts`.

---

## 6. The layers (what to check when a scenario targets one of them)

### 6a. Guardrail (pre-agent screen, runs in core)

Config — `~/gantry/settings.yaml` (schema documented in
`~/gantry/settings.example.yaml` and repo `settings.example.yaml`):

```yaml
agents:
  boondi_support:
    plugins:
      guardrail:
        file: guardrails/guardrail.ts # exact file under the agent folder; alternates switchable here
        model: haiku # used only by explicit classifier-mode fallback
        mode: both # both | deterministic | classifier
```

`mode: both` = free deterministic regex stage first
(`evaluateDeterministic()`). Boondi's policy supplies an inline scope block, so
unresolved allowed turns go directly to the main Boondi LLM call with the
inline scope block attached. Decision shape:
`{action:'allow'}` or
`{action:'direct_response', responseKind: greeting|scope_rejection|scope_clarification}`.

Deterministic rules in `agents/boondi_support/guardrails/guardrail.ts` (repo
file, symlinked into the runtime): cold-contact bare greeting → canned
greeting (a returning customer's greeting is allowed through to the agent for
personal recognition); internal probes (mcp/system prompt/jailbreak…) →
scope_rejection; BSS keywords (order/delivery/refund…) → allow; obvious
off-topic (weather/coding/cricket…) → scope_rejection; bare
continuations/disputes with in-scope context → allow.

A `direct_response` message **never spawns the agent** but is fully recorded —
inbound + canned outbound both appear in the admin panel (verified: "hi" from
a fresh number → canned greeting in 0.7 s). Guardrail edits go live on core
restart (prod runs the `.ts` directly via node 24 type-stripping — keep it
type-strippable, no enums).

### 6b. Agent (Claude Agent SDK)

- Prompts: `SOUL.md` (persona) + `CLAUDE.md` (tool ops/output discipline) from
  the agent folder, synced into the prompt profile **at core boot only**
  (`syncAuthoredPromptsAtBoot`, `apps/core/src/app/bootstrap/startup.ts`) —
  **editing them does nothing until a restart**.
- Model: `sonnet`, thinking disabled (settings.yaml). Guardrail-allowed
  messages spawn the runner; with `GANTRY_CHILD_RUNNER_FROM_SOURCE=1` (set in
  dev) the child runs from TS source, otherwise from `dist/` — runner-side
  code changes need `npm run build` in that case.
- Shopify/CRM tools go through `mcp_call_tool` → file-IPC → core's proxy,
  which signs `X-Caller-Identity` (HMAC, `MCP_IDENTITY_SECRET`, phone from the
  conversation JID, test override §2 applies) and enforces
  `allowed_tool_patterns` (settings.yaml `mcp_servers` block).

### 6c. Background extraction (CRM + memory) and dreaming

Session end = `memory.idle_end_minutes` of silence (settings.yaml; currently
**5**, temp-lowered for testing — prod value 30). An idle sweep (every 30 s)
then writes a digest row: `gantry.agent_session_digests` with
`trigger='session-end'`. That digest fans out to:

1. **Memory facts** (core): extraction prompt
   `agents/boondi_support/memory_extractor/memory_extractor.md` →
   `gantry.memory_items` (keyed `agent_id='agent:boondi_support'`,
   `user_id=<phone>`). View: admin panel right pane or
   `/api/memory?phone=<phone>`.
2. **CRM opportunities** (mcp-crm digest-watcher): polls digests behind cursor
   `boondi_crm.boondi_digest_cursor` (interval
   `BOONDI_CRM_RECONCILE_INTERVAL_MS`, default 240 s, test setup uses 10 s),
   runs one Agent-SDK extraction per digest →
   `boondi_crm.boondi_business_records` (status ladder
   query→qualifying→lead, bands P5–P1). View: `/leads` page or `/api/records`.
3. **Dreaming** (nightly consolidation): settings.yaml `memory.dreaming`
   enabled, `cron: '0 1 * * *'`.

**Don't wait for timers in tests** — drive it with slash commands. A command
is just a normal signed webhook message whose text IS the command (e.g.
`sendWebhook({ text: '/new', from: '000000905' })`), and it works **only from
numbers in `GANTRY_TEST_OPERATOR_PHONE`** (the session-command allowance).
These are the commands the Boondi workflow uses:

| Command                  | What it does                                                                                                                                                                                                                                                                                                                                                                                             | Reply to expect                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `/new`                   | **Starts a fresh session** for this conversation: archives and clears the current agent session, so the next message begins with a clean context window (also the recovery path when a persisted session is corrupted; older queued messages are not replayed). The DB transcript and admin-panel history are NOT touched. Use between scenarios — never as teardown (transcripts are review artifacts). | `Started a fresh session.` (on failure: `/new failed. The session is unchanged.`)                                                                       |
| `/digest-session`        | Forces the **session digest + memory-fact extraction NOW** (same collector the idle sweep uses — no waiting for `idle_end_minutes`). The digest row is what the CRM watcher's automatic run consumes.                                                                                                                                                                                                    | `Digest processed. New digest: yes`                                                                                                                     | `no new customer turns`. `Memory facts saved: N.` |
| `/extract-leads-queries` | Runs **CRM lead/query extraction for THIS conversation immediately** (agent-declared command → POST to mcp-crm `/admin/extract-leads-queries`). Reads the transcript directly, so it does NOT need a digest first — that's the difference from the automatic path, where the watcher only runs after a session-end digest exists.                                                                        | ack `Running lead/query extraction…`, then `Lead/query extraction processed. Extracted: N. Created: N. Updated: N. Skipped: N.` (wait up to 2 min — §5) |
| `/commands`              | Lists the commands available in this conversation — useful to discover what's active.                                                                                                                                                                                                                                                                                                                    | the help list (built-ins + agent commands)                                                                                                              |

Sources: built-ins in `apps/core/src/session/session-commands.ts` (+
`session-manual-extraction-commands.ts`, names in
`application/commands/builtin-command-names.ts`); the agent-declared one in
`agents/boondi_support/commands/extract-leads-queries.ts`, activated via
settings.yaml `plugins.commands`. (`/stop` also exists to abort a hung run —
replies `Stopping current run.` / `No active run to stop.`)

Verified live (2026-06-10): a one-line kaju-katli price question +
`/extract-leads-queries` → `Extracted: 1. Created: 1.` → a `status:"query"`,
`source:"extractor"` row in `boondi_business_records` with the question as
`triggerExcerpt`.

---

## 7. Admin panel = the proof of record

Separate Next.js repo at `**~/Desktop/boondi-admin`** (its own git repo,
sibling of gantry on the Desktop; `npm run dev`, port 3000; DB session forced
read-only). Boondi and the admin panel **work together as one system**: Boondi
writes conversations/records/memory to Postgres, the panel reads them — so
**open that repo whenever it helps\*\*: to understand exactly what a page or API
shows (queries live in `lib/queries.ts`), or to check and change something
(fix a query, surface a column, extend an API) when a test or investigation
needs it. The one invariant to preserve when changing it: the DB connection
stays read-only — the panel never writes to gantry's Postgres.

**Every test conversation MUST be visible here, both directions — that is the
proof the pipeline worked.** If a test ran but the panel shows nothing, the
test did not pass, whatever the logs say.

- `/` — WhatsApp-style two-pane chat list (10 s auto-refresh + on-focus).
  Deep link to one conversation: `http://localhost:3000/?c=conversation:wa:<phone>`
- `/leads` — Leads tab (lead/handed_off/won/lost) vs Queries tab
  (query/qualifying), with band/score/intent and links back to the chat.
- APIs (curl-able for assertions): `/api/conversations`,
  `/api/messages?conversationId=conversation:wa:<phone>`,
  `/api/memory?phone=<phone>` (memory facts + open records),
  `/api/records` (all opportunities).

Quirk: outbound `senderName` shows the bot/agent title ("Gantry"/"Boondi");
customer names come from inbound `sender_display_name`.

---

## 8. Clean state & the scenario harness

- **Per-phone reset** (deterministic reruns): `scripts/lib/reset.mjs`
  `resetTestData(client, phones)` deletes the conversation cascade, sessions,
  runs, digests, CRM records, digest cursor, memory items **and the
  memory-extraction cursor** (else a reused phone looks "already extracted"
  and no facts get saved), then `seedReturning` re-seeds the `000000050`
  returning persona. The regression harness runs this automatically pre-run.
  Refuses non-local DB hosts unless `BOONDI_ALLOW_DB_RESET=1`.
- **Full fresh start** — when the DB/sessions/backlogs are cluttered and you
  want a clean slate (no old conversations, digests, memory, jobs):
  ```bash
  cd /Users/caw-d/Desktop/gantry
  # 1) kill the running stack (§3 kill block)
  pkill -f "apps/core/src/index.ts" 2>/dev/null; pkill -f "packages/mcp-crm/src/index.ts" 2>/dev/null
  # 2) wipe: drops the gantry-postgres data volume + runtime state. KEEPS ~/gantry/.env,
  #    settings.yaml, and agents/ (the repo symlinks), and auto-extracts + restores the
  #    Claude OAuth token — it aborts BEFORE deleting anything if the token can't be
  #    recovered, so the token is never your problem.
  bash ops/reset-runtime/reset-gantry-runtime.sh --yes
  # 3) restart the dev stack (§3, plain npm run dev) — core and mcp-crm recreate
  #    their schemas via boot migrations. Restart boondi-admin only if its queries
  #    error afterwards.
  npm run dev > /tmp/gantry-core-dev.log 2>&1 &
  (cd packages/mcp-crm && npm run dev > /tmp/mcp-crm-dev.log 2>&1 &)
  # shopify (:8081) keeps running through a DB reset; start it the same way if down
  ```
  `--dry-run` previews the plan. The script cycles only the Postgres
  container — restarting the Gantry dev servers afterwards (step 3) is on you,
  which is why the kill+restart is part of this flow.
- **Scenario suites** (`scripts/`, conventions in `scripts/AGENTS.md`):

```bash
node scripts/boondi-regression.mjs                # all groups: conversation, shopify, crm
node scripts/boondi-regression.mjs shopify crm    # subset
node scripts/boondi-isolation.mjs                 # concurrent users, cross-chat bleed guard
node scripts/measure-latency.mjs                  # reply-latency measurement
```

Scenarios live in `scripts/boondi-scenarios.json` (each declares its own
fake phone). The harness judges conversation/shopify groups from the flow
log: core stdout must be tee'd to the file the harness reads —
`GANTRY_DEV_LOG`, default `/tmp/gantry-dev.log`. **Check the env on the
running core**: `.env` may point `GANTRY_DEV_LOG` elsewhere (it pointed at
`/tmp/gantry-capture.log` on 2026-06-10), and a hand-started core in a
terminal tees nowhere — `lsof -p <core-pid> | awk '$4=="1u"'` shows where
stdout goes. Prereq env for harness runs is exactly what
`scripts/boondi-test-setup.sh` sets (flow log, dry-run, operator phones,
caller-identity override, short CRM poll) plus `IDLE_TIMEOUT=2500` by default.
For warm-retention latency runs, start the same script with
`BOONDI_TEST_IDLE_TIMEOUT_MS=20000` so a realistic follow-up can reach the live
runner before stdin closes.

---

## 9. Debugging — no reply, or the wrong reply

**First reflex when confused: read the flow log before theorizing.**
`GANTRY_FLOW_LOG=1` logs JSON events (grep keys: `flow`, `chatJid`) —
`flow:guardrail` (decision + reason), `flow:mcp.request` (tool calls),
`flow:outbound` (final text) — which trace each message's whole journey.
Location depends on launch: setup script → `$GANTRY_DEV_LOG` (default
`/tmp/gantry-dev.log`); hand-started → that terminal's stdout
(`lsof -p <core-pid> | awk '$4=="1u"'`).

**No reply after 60 s — walk the chain:**

1. Webhook ACK was 200? (401 = body/signature mismatch — sign the exact bytes;
   503 = Interakt channel not enabled.)
2. Inbound row visible in admin panel? No → payload was filtered: check
   `type`/`chat_message_type`/`message_content_type`/`channel_phone_number`,
   or duplicate `message.id`.
3. `flow:guardrail` event? `direct_response` means the canned reply IS the
   reply (it's in the transcript).
4. Agent never spawned / queue stuck → warm runs hogging active slots (30-min
   `IDLE_TIMEOUT`, §3), or an orphaned second core double-processing — one
   core only.
5. Reply came but it's the vague **"small hiccup pulling that up"** apology →
   that is the LLM's blanket fallback for a FAILED TOOL CALL, not a real
   answer. Diagnose at the tool layer; two known causes that look identical:

- **no `flow:mcp.request` in the log + ~70 s turn** → IPC watcher never
  started (stale `~/gantry/data/ipc/.lock` from PID recycling; fixed in
  `apps/core/src/runtime/ipc-filesystem.ts`, but the symptom signature is
  worth knowing);
- **fast turn + mcp.request present + tool result `isError NOT_FOUND`** →
  Shopify Admin API 404: the app lost authorization on the shop
  (re-authorize in Shopify; token grant can still 200 while graphql.json
  404s).

6. `delivery_status: failed` on the outbound row is **normal for fake
   numbers** (provider rejects) and for real numbers outside WhatsApp's 24 h
   service window — the persisted text still proves the pipeline.

**Config changes don't take effect?** `.env`, `settings.yaml`, `SOUL.md`,
`CLAUDE.md` and the guardrail file are all read/synced at **core start** —
restart core. Runner-side TS changes need `npm run build` unless
`GANTRY_CHILD_RUNNER_FROM_SOURCE=1`.

---

## 10. Recipe: "test scenario X"

1. **Preflight** (§3 one-liner): 4710/8081/8082/3000 up; confirm
   `GANTRY_OUTBOUND_DRYRUN=1` + operator list on the live core process (§2).
2. **Pick a fake listed number** (e.g. from `000000901–906`; avoid
   `000000050` unless testing the returning persona). Optionally reset it
   (§8) for a clean run — otherwise prior context is part of the scenario.
3. **Send each customer turn** via `scripts/lib/webhook.mjs` (§4); after each
   send, **poll every 5 s** (§5) until the outbound reply lands — chat turns
   max 50 s, command replies max 2 min, then debug (§9). Reply arrived early ⇒
   proceed immediately.
4. **For CRM/memory assertions** don't wait for idle timers: send
   `/digest-session` and `/extract-leads-queries` from
   the same number (§6c), then check `/api/records` and
   `/api/memory?phone=…`.
5. **Prove it in the admin panel** (§7): link
   `http://localhost:3000/?c=conversation:wa:<phone>` (and `/leads` when
   relevant). Leave the transcript in place — no teardown `/new`.
6. **Report**: quote the actual replies, timings, records created, and any
   flow-log evidence.

### Worked example — "check the conversation for number X and see why Boondi replied 'y' instead of 'z'"

1. Transcript: `curl -s "http://localhost:3000/api/messages?conversationId=conversation:wa:X"`
   — find the exact inbound turn and the reply around it (or the deep link in
   the browser).
2. Was it the guardrail? A canned greeting/scope line in <1 s with no tool
   activity = `direct_response` — check `flow:guardrail` for
   `guardrailDecision`/`guardrailReason`, then the rule in
   `agents/boondi_support/guardrails/guardrail.ts`.
3. Was it a tool failure? "small hiccup"/escalation phrasing ⇒ §9 step 5 —
   find `flow:mcp.request` for that turn and the tool result's error `code`;
   `CLAUDE.md`'s error-code table maps codes to the exact customer phrasing.
4. Was it the prompt? If the tool returned good data but the wording violates
   expectations, the governing rules are `agents/boondi_support/CLAUDE.md`
   (output discipline, error table, identity rules) and `SOUL.md` (§ persona /
   restricted actions) — remember both apply only as of the last core restart.
5. Was it memory/CRM context? `/api/memory?phone=X` shows what the agent was
   recognizing; `get_open_records` results come from
   `boondi_crm.boondi_business_records`.

---

_Verified live 2026-06-10: signed webhook from fake `000000905` → guardrail
allow → sonnet agent → Shopify catalogue lookup → reply persisted + visible in
admin panel in 21 s (`deliveryStatus: sent`); bare "hi" from fresh `000000904`
via raw curl → canned guardrail greeting in 0.7 s; `/extract-leads-queries` →
ack + `Extracted: 1. Created: 1.` → `status:"query"` row in
`boondi_crm.boondi_business_records`._
