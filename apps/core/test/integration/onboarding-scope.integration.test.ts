import { describe, expect, it } from 'vitest';

import { AgentE2EApiClient } from '../agent-e2e/harness/api-client.js';
import { startTestControlServer } from '../harness/control-http-server.js';

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
  };
}

describe('onboarding API scope enforcement integration', () => {
  it('returns 403 when a sessions-only key attempts agent creation', async () => {
    const server = await startTestControlServer({
      token: 'sessions-only-onboarding-key',
      appId: 'default',
      scopes: ['sessions:read', 'sessions:write'],
    });
    const api = new AgentE2EApiClient(server.baseUrl, server.token);

    try {
      const response = await api.request<ErrorResponse>('POST', '/v1/agents', {
        body: { appId: 'default', name: 'Forbidden onboarding agent' },
      });

      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'API key is missing required scope agents:admin',
        retryable: false,
      });
      expect(response.body.error.requestId).toEqual(expect.any(String));
    } finally {
      await server.close();
    }
  });
});
