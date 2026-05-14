# NestJS Quickstart

```ts
// myclaw.client.ts
import { Injectable } from '@nestjs/common';
import { createClient } from '@myclaw/sdk';

@Injectable()
export class MyClawClientService {
  readonly client = createClient({
    socketPath: process.env.MYCLAW_CONTROL_SOCKET_PATH,
    apiKey: process.env.MYCLAW_SESSIONS_API_KEY!,
  });
}
```

```ts
// agent.service.ts
import { Injectable } from '@nestjs/common';
import { MyClawClientService } from './myclaw.client';

@Injectable()
export class AgentService {
  constructor(private readonly myclaw: MyClawClientService) {}

  async ask(conversationId: string, message: string) {
    const session = await this.myclaw.client.sessions.ensure({
      conversationId,
      responseMode: 'sse',
    });

    const accepted = await this.myclaw.client.sessions.sendMessage({
      sessionId: session.sessionId,
      message,
      senderId: 'backend',
      senderName: 'NestJS',
    });

    return this.myclaw.client.sessions.wait(session.sessionId, {
      afterEventId: accepted.acceptedEventId,
      timeoutMs: 120_000,
    });
  }

  async createManualJob(sessionId: string) {
    return this.myclaw.client.jobs.create({
      sessionId,
      name: 'manual-summary',
      kind: 'manual',
      prompt: 'Summarize the most recent session activity.',
    });
  }

  async triggerAndWait(jobId: string) {
    const trigger = await this.myclaw.client.jobs.trigger(jobId);
    return this.myclaw.client.jobs.wait(trigger.triggerId, 120_000);
  }
}
```

Normal sidecar calls derive `appId` from the API key. Pass `appId` only as an
advanced assertion when the caller intentionally verifies a known app scope.
