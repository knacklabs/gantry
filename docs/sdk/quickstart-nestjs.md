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

  async createManualJob(sessionId: string) {
    return this.gantry.client.jobs.create({
      sessionId,
      name: 'manual-summary',
      kind: 'manual',
      prompt: 'Summarize the most recent session activity.',
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

## Provision the agent locked

A customer-facing example agent (a support or product assistant your end users
talk to through this backend) should be provisioned with
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
