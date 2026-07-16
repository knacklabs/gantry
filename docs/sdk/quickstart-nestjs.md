# NestJS Quickstart

```ts
// gantry.client.ts
import { Injectable } from '@nestjs/common';
import { createClient } from '@gantry/sdk';

@Injectable()
export class GantryClientService {
  readonly client = createClient({
    socketPath: process.env.GANTRY_CONTROL_SOCKET_PATH,
    apiKey: process.env.GANTRY_SESSIONS_API_KEY!,
  });
}
```

```ts
// agent.service.ts
import { Injectable } from '@nestjs/common';
import { GantryClientService } from './gantry.client';

@Injectable()
export class AgentService {
  constructor(private readonly gantry: GantryClientService) {}

  async ask(conversationId: string, message: string) {
    const session = await this.gantry.client.sessions.ensure({
      conversationId,
      responseMode: 'sse',
    });

    const accepted = await this.gantry.client.sessions.sendMessage({
      sessionId: session.sessionId,
      message,
      senderId: 'backend',
      senderName: 'NestJS',
    });

    return this.gantry.client.sessions.wait(session.sessionId, {
      afterEventId: accepted.acceptedEventId,
      timeoutMs: 120_000,
    });
  }

  async createManualJob(session: { sessionId: string; chatJid: string }) {
    return this.gantry.client.jobs.create({
      name: 'manual-summary',
      kind: 'manual',
      prompt: 'Summarize the most recent session activity.',
      executionContext: {
        conversationJid: session.chatJid,
        threadId: null,
        workspaceKey: 'main_agent',
        sessionId: session.sessionId,
      },
    });
  }

  async triggerAndWait(jobId: string) {
    const trigger = await this.gantry.client.jobs.trigger(jobId);
    return this.gantry.client.jobs.wait(trigger.triggerId, 120_000);
  }
}
```

Normal sidecar calls derive `appId` from the API key. Pass `appId` only as an
advanced assertion when the caller intentionally verifies a known app scope.

## Structured output as a service method

```ts
async extractInvoice(sessionId: string, documentText: string) {
  const accepted = await this.gantry.client.sessions.sendMessage({
    sessionId,
    message: `Extract the invoice fields:\n${documentText}`,
    response_schema: {
      type: 'object',
      required: ['vendor', 'total'],
      properties: {
        vendor: { type: 'string' },
        total: { type: 'number' },
        dueDate: { type: 'string' },
      },
    },
  });
  const event = await this.gantry.client.sessions.wait(sessionId, {
    afterEventId: accepted.acceptedEventId,
    timeoutMs: 60_000,
  });
  return JSON.parse((event.payload as { text: string }).text);
}
```

## Streaming to the browser

```ts
// events.controller.ts
@Get('sessions/:sessionId/events')
async stream(
  @Param('sessionId') sessionId: string,
  @Query('afterEventId') afterEventId: string,
  @Res() res: Response,
) {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  for await (const event of this.gantry.client.sessions.stream(sessionId, {
    afterEventId: Number(afterEventId || 0),
  })) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}
```

## Receiving lifecycle webhooks

Register a webhook with `eventTypes` (for example `run.completed`,
`interaction.pending`) and verify deliveries with the SDK helper. NestJS must
expose the raw body: `NestFactory.create(AppModule, { rawBody: true })`.

```ts
// gantry-webhook.controller.ts
import { verifyWebhookSignature } from '@gantry/sdk';

@Post('hooks/gantry')
handle(@Req() req: RawBodyRequest<Request>) {
  const ok = verifyWebhookSignature({
    secret: process.env.GANTRY_WEBHOOK_SECRET!,
    timestamp: req.headers['x-gantry-webhook-timestamp'] as string,
    eventId: req.headers['x-gantry-webhook-id'] as string,
    eventType: req.headers['x-gantry-webhook-event'] as string,
    signature: req.headers['x-gantry-webhook-signature'] as string,
    rawBody: req.rawBody!.toString(),
    toleranceMs: 5 * 60_000,
  });
  if (!ok) throw new UnauthorizedException('invalid signature');
  const event = JSON.parse(req.rawBody!.toString());
  // deduplicate on x-gantry-webhook-id; react to event.eventType
  return { ok: true };
}
```

## Provision the agent locked

A customer-facing example agent (a support or product assistant your end users
talk to through this backend) should be provisioned with
`agents.<id>.access.preset: locked` in settings, so it physically cannot
enumerate or invoke any `request_*`/`admin_*`/`settings_*` tool and works only
with capabilities an operator pre-provisioned. See
[Locked Preset](../decisions/2026-06-11-locked-preset.md) and
[Agent Internals For SDK Consumers](./agent-internals.md#locked-access-preset).
The preset is set on the agent, not in SDK calls — your client code is unchanged.

## Beyond chat turns

The same session machinery drives headless workflow steps: send
`response_schema` with a message to get validated JSON back from an
inline-runtime agent, pass per-request `effort` / `max_output_tokens`, make raw
model calls without an agent via the Direct LLM API (`baseURL` swap on official
provider SDKs), and subscribe webhooks to `run.completed` /
`interaction.pending` instead of polling. See the
[SDK API Reference](./api-reference.md) for all of these.

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
