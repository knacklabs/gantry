# Authenticating Gantry/Boondi to Anthropic via OneCLI

Gantry never talks to `api.anthropic.com` directly. Every LLM call goes through
the OneCLI gateway (`gantry-onecli` container, MITM proxy), and OneCLI injects
the actual Anthropic credential header onto outgoing requests. This doc
explains the **right** credential to use, how to install it, how to rotate it,
and how to recover when things break.

## The architecture in one diagram

```
WhatsApp/Interakt → Gantry webhook → Boondi agent (child process)
                                       │
                                       ▼
                              Claude Agent SDK
                                       │
                       sends placeholder Authorization
                                       ▼
                              OneCLI MITM proxy ── injects real header
                                       │            from `type: anthropic`
                                       ▼            secret
                              api.anthropic.com
```

Key invariants (enforced by
`apps/core/src/runner/claude/runtime-env.ts` and
`apps/core/src/adapters/credentials/onecli/env-policy.ts`):

- OneCLI's container-config endpoint may provide an `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` value to the agent process, but Gantry's
  env-policy filter (`env-policy.ts:190-203`) only accepts the literal string
  `"placeholder"` for those keys — any *real* secret value is **rejected**
  with `forbiddenKey(key)`. This is the rail that ensures real credentials
  reach Anthropic via OneCLI's MITM header injection, never via the agent's
  process env.
- OneCLI's `type: "anthropic"` secret auto-detects the credential
  (`detectAnthropicAuthMode` in the OneCLI source) and stores
  `metadata.authMode` accordingly:
  - Token starts with `sk-ant-api…` → `"api-key"` → injects `x-api-key`.
  - Token starts with `sk-ant-oat…` → `"oauth"` → injects
    `Authorization: Bearer …` and the OAuth-mode beta header(s) Anthropic
    requires for that flow.
- `type: "generic"` exists too, but it only injects whatever
  `headerName` + `valueFormat` you hand-write — it does **not** apply the
  oauth-mode beta header, so an `sk-ant-oat…` token plumbed through
  `type: "generic"` with `Authorization: Bearer {value}` will still 401 even
  while OneCLI's gateway logs report `injections_applied=1`. Always use
  `type: "anthropic"` for `api.anthropic.com`; let OneCLI pick the right
  flow from the token prefix.

## Which credential should you use?

Per [Anthropic's authentication docs](https://code.claude.com/docs/en/authentication):

| Credential | Source | Lifetime | When to use |
|---|---|---|---|
| `sk-ant-oat01-…` from `claude setup-token` | Subscription (Pro/Max/Team/Enterprise) | **1 year** | Local dev, services like Gantry — uses your subscription quota |
| `sk-ant-api…` from [Claude Console](https://platform.claude.com/settings/keys) | API workspace | No expiry (rotate manually) | Direct API billing, production with separate quota |
| Interactive `/login` OAuth token | `claude` CLI browser flow | ~8h + short-lived refresh chain | Interactive `claude` only — **don't use here**, the refresh chain gets invalidated quickly |

For Gantry / Boondi, the **only correct path** is one of the first two. The
interactive-`/login` token (also lives in the macOS keychain) is rotated
aggressively and isn't safe for unattended use.

## Initial setup (do this once)

```bash
claude setup-token
```

That walks you through a browser OAuth, then prints a 1-year token starting
with `sk-ant-oat01-…` to your terminal. **It is printed once and not saved
anywhere** — copy it immediately. Anthropic's docs are explicit on this.

Then install it into OneCLI (one of two ways):

### a) Via the OneCLI web UI

1. Open <http://localhost:10254> in your browser.
2. Go to **Connections → Secrets** tab.
3. Add a new secret with type **Anthropic**, paste the token, and set
   `hostPattern=api.anthropic.com` and `pathPattern=/*`.

### b) Via curl (what `scripts/rotate-anthropic-credential.sh` does)

```bash
# Replace the value on an existing anthropic secret …
SECRET_ID=$(curl -s http://127.0.0.1:10254/api/secrets \
  | jq -r '.[] | select(.type=="anthropic" and .hostPattern=="api.anthropic.com") | .id')
curl -X PATCH "http://127.0.0.1:10254/api/secrets/$SECRET_ID" \
  -H "Content-Type: application/json" \
  -d "{\"value\":\"$TOKEN\"}"

# … or create a new one if none exists yet
curl -X POST "http://127.0.0.1:10254/api/secrets" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Anthropic (setup-token)\",
       \"type\":\"anthropic\",
       \"value\":\"$TOKEN\",
       \"hostPattern\":\"api.anthropic.com\",
       \"pathPattern\":\"/*\"}"
```

After installing, restart Gantry so its credential broker re-fetches the
OneCLI container config:

```bash
# Either Ctrl+C your `npm run dev`, or use the preview manager.
npm run dev
```

Verify with a webhook replay (see *Verification* below).

## Rotating before expiry (run before the 1-year mark)

The same flow as initial setup — `claude setup-token` + paste into OneCLI. The
included helper does both steps interactively:

```bash
bash scripts/rotate-anthropic-credential.sh
```

It prompts you to paste the token, then PATCHes the existing OneCLI secret.

## Recovery flowchart

Walk these in order — each layer assumes the previous one is healthy.

```
Boondi not replying.
│
├── (1) Is the webhook reaching Gantry at all?
│     Check: tail your `npm run dev` terminal for the line
│            `I AM RUNINNGGGGGGGGGG…` printed by the Interakt webhook handler
│            ([interakt-webhook.ts:19](apps/core/src/control/server/routes/interakt-webhook.ts:19)).
│     Missing → ngrok/Interakt webhook URL/signature problem, not auth.
│
├── (2) Did routing pick an agent for this chat?
│     Check: same terminal for `>>> FLOWING FORWARD: <jid> | … | agent=<folder>`
│            (added in [channel-persistence-handlers.ts:83-85](apps/core/src/app/bootstrap/channel-persistence-handlers.ts:83-85)).
│     Missing → no `agent_conversation_bindings` row for that JID, or it was
│            removed by the desired-state reconciler because settings.yaml
│            didn't declare it. Add the binding under
│            `agents.<folder>.bindings` in settings.yaml.
│
├── (3) Did the agent process invoke the SDK at all?
│     Check: `logs/llm-debug.log` contains `=== NEW RUN ===` for this run.
│     Missing → agent spawn failed before SDK initialized. Look in the gantry
│            `docker compose`/host logs for spawn errors (often missing env,
│            credential broker timeout, MCP server crash).
│
└── (4) The SDK ran — inspect the `type: "result"` message in
       `logs/llm-debug.log`:
       │
       ├── is_error: true, api_error_status: 401, result mentions "Invalid API key"
       │     Look at OneCLI gateway log:
       │     `docker logs gantry-onecli --since 5m | grep status=401`
       │     ├── injections_applied=1  →  Credential IS reaching Anthropic,
       │     │     server rejected it. Token expired/revoked → rotate via
       │     │     `claude setup-token` + `bash scripts/rotate-anthropic-credential.sh`.
       │     └── injections_applied=0  →  OneCLI isn't matching the request to
       │           a secret. Verify a row exists with type=anthropic,
       │           hostPattern=api.anthropic.com, pathPattern=/*.
       │
       ├── is_error: true, api_error_status: 429  →  rate-limited. Wait or
       │     check your subscription quota.
       │
       └── is_error: false  →  Everything worked. If Boondi's reply still
             never reaches the user, the failure is downstream: Interakt
             outbound API, channel adapter, etc.
```

## Why the macOS keychain token doesn't work here

The keychain entry `Claude Code-credentials` (read with
`security find-generic-password -s "Claude Code-credentials"`) stores the
**interactive** OAuth credential issued by `claude /login`. Its
`accessToken` expires every ~8 hours, and its `refreshToken` rotates on each
successful exchange (single-use chain). Once the chain is broken — long
inactivity, a concurrent refresh, or the previous refresh being consumed by
the interactive client — the server responds with
`{"error":"invalid_grant","error_description":"Refresh token not found or
invalid"}` and there's no programmatic way back into the chain. Re-login
through the browser is the only fix.

That's the wrong mechanism for an unattended service like Gantry. Per
[Anthropic's authentication docs](https://code.claude.com/docs/en/authentication),
`claude setup-token` is the supported path for non-interactive use: it issues
a separate long-lived (~1 year) OAuth credential that doesn't participate in
the interactive refresh chain. Use that.

## Verification

After installing or rotating, restart Gantry, then replay a captured Interakt
webhook (or send a real WhatsApp message). The healthy signal in
`logs/llm-debug.log` is:

```json
{
  "type": "result",
  "is_error": false,
  "api_error_status": null,
  "num_turns": >= 1,
  "result": "<Boondi's reply text>",
  "usage": { "input_tokens": >0, "output_tokens": >0 }
}
```

And in `docker logs gantry-onecli --since 1m`:

```
INFO MITM method=POST url=https://api.anthropic.com:443/v1/messages?...
     status=200 injections_applied=1
```

The flowchart above references two debug additions that are currently in the
code. They were added while diagnosing this issue; remove (or guard behind a
flag) before shipping:

- [channel-persistence-handlers.ts:83-85](apps/core/src/app/bootstrap/channel-persistence-handlers.ts:83-85)
  — the `console.log(">>> FLOWING FORWARD: …")`.
- [query-loop.ts:7-16](apps/core/src/runner/claude/query-loop.ts:7-16) plus
  the `llmDebug()` calls on lines 88-89 and 236. Note: the agent process runs
  from compiled output, so the equivalent edits also live in
  [dist/runner/claude/query-loop.js](dist/runner/claude/query-loop.js) and
  will be overwritten by the next `npm run build`. Re-apply or upstream the
  source edits if you keep them.
