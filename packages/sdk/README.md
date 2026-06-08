# @gantry/sdk

Node.js SDK for the [Gantry](https://github.com/vrknetha/gantry) runtime
control API. Talk to a running Gantry instance over HTTP or a Unix socket:
sessions, jobs, agents, memory, webhooks, ingresses, and signing helpers.

> **Node-only.** The SDK uses `node:http`, `node:https`, and `node:crypto`. It
> is not designed to run in browsers — and you should not put a control API
> key in client code anyway.

## Install

```bash
npm i @gantry/sdk
```

Requires Node.js 24 (matches the Gantry runtime's supported range).

## Quickstart

```ts
import { createClient } from '@gantry/sdk';

const client = createClient({
  apiKey: process.env.GANTRY_API_KEY!,
  baseUrl: 'http://127.0.0.1:3939', // or omit to use the default
  // socketPath: '/run/gantry.sock', // optional Unix socket transport
  // timeoutMs: 60_000,
});

const health = await client.health();
console.log(health.status);

const { sessionId } = await client.sessions.ensure({
  conversationId: 'channel:slack:C0123ABCD',
  title: 'Quarterly review prep',
});

await client.sessions.sendMessage({
  sessionId,
  message: 'Pull the last five quarterly metrics from memory.',
});

for await (const event of client.sessions.stream(sessionId)) {
  console.log(event.eventType, event.payload);
}
```

## Surface

The client exposes these resource namespaces, each backed by `/v1/*`
endpoints on the running runtime:

- `client.sessions` — `ensure`, `sendMessage`, `listEvents`, `stream` (SSE), `wait`
- `client.jobs` — `create`, `list`, `get`, `update`, `delete`, `pause`, `resume`, `trigger`, `wait`
- `client.runs` — `list`, `get`
- `client.models` — `list`, `defaults.get`, `defaults.update`, `preview`
- `client.agents` — admin CRUD plus `skills`, `mcpServers`, `conversationBindings`
- `client.skills` — install, list, and inspect skills
- `client.mcpServers` — catalog of MCP servers
- `client.providers` — list channel providers
- `client.providerConnections` — CRUD plus `discoverConversations`
- `client.conversations` — `list`, `get`, `messages`, get/set `approvers`
- `client.webhooks` — `register`, `list`, `update`, `delete`, `test`, `replayDeadLetter`, `purgeDeadLetter`
- `client.memory` — `save`, `search`, `list`, `patch`, `delete`, plus `dreaming.trigger` / `dreaming.status`
- `client.settings` — read runtime settings
- `client.ingresses` — manage external ingress configurations
- `conversationMessageTarget` — build a typed signed-ingress target for an existing Gantry conversation/thread.

### Standalone signing helpers

```ts
import {
  signIngressRequest,
  verifyIngressSignature,
  verifyWebhookSignature,
} from '@gantry/sdk';
```

- `signIngressRequest`, `signIngressSignaturePayload`, `buildIngressSignaturePayload` — HMAC signing for posting external events into Gantry.
- `verifyIngressSignature` — verify inbound ingress signatures on the runtime side.
- `verifyWebhookSignature` — verify outbound webhook deliveries on your receiver.

## Errors

All client methods reject with a `GantryError` (extends `Error`) carrying
`code`, optional `details`, `requestId`, `retryable`, `restartRequired`, and
`nextAction`. Inspect these to drive retry or restart logic.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).
