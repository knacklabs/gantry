import { expect, it } from 'vitest';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import {
  coordinatePermissionDecision,
  registerPermissionRunRestriction,
  unregisterPermissionRunRestriction,
} from '@core/runtime/permission-decision-coordinator.js';
import { INVOCATION_REUSED_REASON } from '@core/runtime/permission-invocation-id.js';

it('refuses new bindings at capacity without losing a live binding, and releases capacity when its authenticated run ends', async () => {
  const key = {
    sourceAgentFolder: 'capacity-agent',
    responseKeyId: 'capacity-run',
  };
  registerPermissionRunRestriction({
    ...key,
    hideAuthorityTools: false,
    runKind: 'interactive',
  });
  const call = (
    invocationId: string,
    text = 'first',
  ): PermissionApprovalRequest => ({
    ...key,
    requestId: invocationId,
    appId: 'capacity-app',
    agentId: 'capacity-agent',
    runId: 'capacity-run',
    invocationId,
    toolName: 'mcp__crm__write',
    toolInput: { text },
  });
  const decide = (request: PermissionApprovalRequest) =>
    coordinatePermissionDecision({
      request,
      deterministicRails: () => undefined,
      tail: async () => ({ approved: true, mode: 'allow_once' }),
    });
  try {
    for (let index = 0; index < 10_000; index += 1)
      expect((await decide(call(`call-${index}`))).approved).toBe(true);
    await expect(decide(call('overflow'))).resolves.toMatchObject({
      approved: false,
      reason:
        'Active runs have reached the tool call limit. Let a run finish, then retry.',
    });
    await expect(decide(call('call-0', 'changed'))).resolves.toMatchObject({
      approved: false,
      reason: INVOCATION_REUSED_REASON,
    });
    await expect(decide(call('call-0'))).resolves.toMatchObject({
      approved: true,
    });
    unregisterPermissionRunRestriction(key);
    registerPermissionRunRestriction({
      ...key,
      hideAuthorityTools: false,
      runKind: 'interactive',
    });
    await expect(decide(call('overflow'))).resolves.toMatchObject({
      approved: true,
    });
    await expect(decide(call('call-0', 'changed'))).resolves.toMatchObject({
      approved: true,
    });
  } finally {
    unregisterPermissionRunRestriction(key);
  }
});
