import { afterEach, expect, it } from 'vitest';

import { startTestControlServer } from '../../harness/control-http-server.js';

type Server = Awaited<ReturnType<typeof startTestControlServer>>;
let server: Server | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

it('rejects an unknown job create field with the generic 400 response', async () => {
  server = await startTestControlServer({
    token: 'job-fields-test-token-0123456789',
    appId: 'default',
    scopes: ['jobs:write'],
  });

  const response = await fetch(`${server.baseUrl}/v1/jobs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Job',
      prompt: 'Run',
      executionContext: {
        conversationJid: 'chat-1',
        threadId: null,
        workspaceKey: 'workspace',
        sessionId: 'session-1',
      },
      unexpectedField: 'unused',
    }),
  });

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: 'INVALID_REQUEST',
      message: 'Unsupported job request field "unexpectedField".',
    },
  });
});
