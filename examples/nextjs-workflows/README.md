# Gantry Next.js workflows

This App Router example keeps `@gantry/sdk`, the official OpenAI client, and
all credentials in server-side route handlers. Its page demonstrates a chat
turn, SSE events, a structured workflow step, Direct LLM inference, a one-hour
usage readout, and signed lifecycle webhooks.

## Build the workspace

From the Gantry repository root:

```sh
npm ci
npm run build
```

The root build includes `npm run build:examples`. Gantry requires Node.js 24
or 25.

## Configure the local sidecar

Generate separate control API and webhook secrets with
`openssl rand -base64 32`. Add the following to `~/gantry/.env`, replacing the
token placeholder:

```env
GANTRY_CONTROL_HOST=127.0.0.1
GANTRY_CONTROL_PORT=3939
GANTRY_CONTROL_API_KEYS_JSON=[{"kid":"nextjs-workflows","token":"REPLACE_WITH_CONTROL_API_TOKEN","appId":"nextjs-workflows","scopes":["sessions:read","sessions:write","webhooks:write","llm:invoke","usage:read"]}]

# Local demo only: allow HTTP delivery to a private loopback address.
GANTRY_CONTROL_ALLOW_INSECURE_WEBHOOKS=true
GANTRY_CONTROL_ALLOW_PRIVATE_WEBHOOKS=true
```

The key uses the exact scopes required by each flow:

- `sessions:write` for `sessions.ensure` and `sessions.sendMessage`;
- `sessions:read` for `sessions.wait` and `sessions.stream`;
- `webhooks:write` to register the lifecycle webhook (the receiver itself uses
  the signing secret, not the API key);
- `llm:invoke` for the Direct LLM API call; and
- `usage:read` for `client.usage.query`.

Do not use the two webhook exceptions for remote or production targets.

Gantry deterministically derives the SDK conversation's agent folder. Compute
it with the same hashing and segment rules as `makeAppGroup`:

```sh
export AGENT_FOLDER="$(node -e 'const {createHash}=require("node:crypto"); const appId="nextjs-workflows", conversationId="demo"; const clean=s=>s.trim().toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,48); const app=clean(appId)||"app", conversation=clean(conversationId)||"session", hash=createHash("sha256").update(appId+"\0"+conversationId).digest("hex").slice(0,12), prefix="app_"+hash+"_", remaining=96-prefix.length, appPart=app.slice(0,Math.max(8,Math.floor(remaining*0.4))), conversationPart=conversation.slice(0,Math.max(8,remaining-appPart.length-1)); console.log((prefix+appPart+"_"+conversationPart).slice(0,96))')"

gantry agent add app:nextjs-workflows:demo \
  --name "Next.js Workflows Demo" \
  --folder "$AGENT_FOLDER" \
  --requires-trigger false \
  --no-test-message
```

In `~/gantry/settings.yaml`, add these fields to the generated
`agents.<derived-folder>` record. Use a registered friendly model alias, not a
raw provider model id:

```yaml
agents:
  app_86a0330e0d88_nextjs_workflows_demo:
    name: 'Next.js Workflows Demo'
    runtime: inline
    model: 'opus'
    access:
      preset: locked
```

Keep the CLI-created App provider account, conversation, and installed-agent
entries. Then apply the sidecar and settings changes:

```sh
gantry settings validate
gantry restart
gantry status
```

Use `gantry model list` if `opus` is not a registered, credentialed alias.

## Run the app

Create `examples/nextjs-workflows/.env.local` with the same control token and a
separate webhook signing secret:

```env
GANTRY_API_KEY=REPLACE_WITH_CONTROL_API_TOKEN
GANTRY_BASE_URL=http://127.0.0.1:3939
GANTRY_DEMO_CONVERSATION_ID=demo
GANTRY_DEMO_MODEL_ALIAS=opus
GANTRY_WEBHOOK_SECRET=REPLACE_WITH_WEBHOOK_SIGNING_SECRET
```

`GANTRY_DEMO_MODEL_ALIAS` is sent to Gantry as a registered alias. The OpenAI
SDK targets `${GANTRY_BASE_URL}/llm/v1`.

```sh
npm run dev --workspace @gantry/example-nextjs-workflows
```

Open `http://127.0.0.1:3000`.

## Register the lifecycle webhook

With Next.js running, export the same two secrets from `.env.local`, then use
the public SDK from the repository root:

```sh
export GANTRY_API_KEY='REPLACE_WITH_CONTROL_API_TOKEN'
export GANTRY_WEBHOOK_SECRET='REPLACE_WITH_WEBHOOK_SIGNING_SECRET'

node --input-type=module <<'NODE'
import { createClient } from '@gantry/sdk';

const client = createClient({
  baseUrl: 'http://127.0.0.1:3939',
  apiKey: process.env.GANTRY_API_KEY,
});

console.log(
  await client.webhooks.register({
    name: 'nextjs-workflows-lifecycle',
    url: 'http://127.0.0.1:3000/api/webhooks/gantry',
    secret: process.env.GANTRY_WEBHOOK_SECRET,
    eventTypes: ['run.completed', 'interaction.pending'],
  }),
);
NODE
```

The receiver verifies the raw body before parsing JSON. Delivery is at least
once; this demo performs no side effects and does not claim durable
deduplication. Production receivers should durably deduplicate on
`x-gantry-webhook-id`.

## Routes

| Route                                            | Purpose                                         |
| ------------------------------------------------ | ----------------------------------------------- |
| `POST /api/chat`                                 | Ensure, send `{ "message": "..." }`, and wait.  |
| `GET /api/stream?sessionId=...&afterEventId=...` | Proxy session events as SSE.                    |
| `POST /api/workflow`                             | Run low-effort schema-validated ticket triage.  |
| `POST /api/llm`                                  | Call Gantry through the OpenAI SDK.             |
| `GET /api/usage`                                 | Read the app's previous hour, grouped by model. |
| `POST /api/webhooks/gantry`                      | Verify and acknowledge lifecycle events.        |
