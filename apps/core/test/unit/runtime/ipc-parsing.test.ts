import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { createSignedIpcRequestEnvelope } from '@core/shared/ipc-signing.js';
import { createIpcAuthEnvelope } from '@core/runtime/ipc-auth.js';
import { clearConsumedIpcRequestIds } from '@core/runtime/ipc-auth-validation.js';
import { parsePermissionIpcRequest } from '@core/runtime/ipc-parsing.js';

function permissionEnvelope(permissionLane: unknown) {
  const auth = createIpcAuthEnvelope('team', undefined, {
    appId: 'default',
    agentId: 'agent:team',
  });
  return createSignedIpcRequestEnvelope(auth.authToken, {
    requestId: `perm-lane-${randomUUID()}`,
    sourceAgentFolder: 'team',
    toolName: 'Bash',
    permissionLane,
    context: {
      appId: 'default',
      agentId: 'agent:team',
      responseKeyId: auth.responseKeyId,
    },
  });
}

describe('parsePermissionIpcRequest', () => {
  afterEach(() => {
    clearConsumedIpcRequestIds({ durable: 'consumed' });
  });

  it.each([
    ['interactive', 'interactive'],
    [' autonomous ', 'autonomous'],
  ] as const)(
    'preserves a signed %s permission lane',
    (rawPermissionLane, permissionLane) => {
      expect(
        parsePermissionIpcRequest(
          permissionEnvelope(rawPermissionLane),
          'team',
        ),
      ).toMatchObject({ permissionLane });
    },
  );

  it('rejects an unknown permission lane', () => {
    expect(
      () =>
        parsePermissionIpcRequest(permissionEnvelope('scheduled'), 'team'),
    ).toThrow('Invalid permission IPC permissionLane');
  });
});
