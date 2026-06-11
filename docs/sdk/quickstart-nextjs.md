# Next.js Quickstart

`@gantry/sdk` is **server-side only**. Use it from route handlers, server
actions, and server components — never from client components or browser
bundles. The control API key and the control transport must never reach the
browser; the examples below run entirely on the server and return only what the
client needs.

```ts
// app/api/agent/route.ts
import { createClient } from '@gantry/sdk';

const client = createClient({
  socketPath: process.env.GANTRY_CONTROL_SOCKET_PATH,
  apiKey: process.env.GANTRY_SESSIONS_API_KEY!,
});

export async function POST(req: Request) {
  const body = await req.json();
  const user = await requireAuthenticatedUser(req);
  const conversationId = await resolveUserConversationId(
    user.id,
    body.conversationId,
  );
  const webhookId = await resolveUserWebhookId(user.id);

  const session = await client.sessions.ensure({
    conversationId,
    title: body.title,
    responseMode: 'both',
    webhookId,
  });

  const accepted = await client.sessions.sendMessage({
    sessionId: session.sessionId,
    message: body.message,
    senderId: user.id,
    senderName: user.name,
  });

  const result = await client.sessions.wait(session.sessionId, {
    afterEventId: accepted.acceptedEventId,
    timeoutMs: 120_000,
  });

  return Response.json({
    session,
    accepted,
    result,
  });
}
```

Normal sidecar calls derive `appId` from the API key. Pass `appId` only as an
advanced assertion when the caller intentionally verifies a known app scope.

## Streaming in a route handler

```ts
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get('sessionId')!;
  const afterEventId = Number(url.searchParams.get('afterEventId') || 0);
  const user = await requireAuthenticatedUser(req);
  await assertUserCanReadSession(user.id, sessionId);

  const stream = new ReadableStream({
    async start(controller) {
      for await (const event of client.sessions.stream(sessionId, {
        afterEventId,
      })) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
```

The route handler proxies the stream to the browser; the SDK client itself stays
on the server.

## Provision the agent locked

A customer-facing example agent (a support or product assistant your end users
talk to through this app) should be provisioned with
`agents.<id>.access.preset: locked` in settings, so it physically cannot
enumerate or invoke any `request_*`/`admin_*`/`settings_*` tool and works only
with capabilities an operator pre-provisioned. See
[Locked Preset](../decisions/2026-06-11-locked-preset.md) and
[Agent Internals For SDK Consumers](./agent-internals.md#locked-access-preset).
The preset is set on the agent, not in SDK calls — your client code is unchanged.

## Going to production

Run Gantry as a same-machine sidecar while one box and live installs are enough.
Move to a separated fleet when you need availability or job throughput beyond one
machine, or to run locked public-facing agents on isolated stacks. Use the
[AWS Terraform runbook](../deployment/aws-terraform.md) to stand up the fleet (or
a locked support stack), and the
[Scaling Decision Guide](../architecture/deployment-profiles.md#scaling-decision-guide-vertical-vs-horizontal)
to decide vertical vs horizontal. The only client changes between shapes are the
base URL (`baseUrl` through the ALB instead of `socketPath`) and how the API key
is provisioned.
