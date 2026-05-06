import { describe, expect, it, vi } from 'vitest';

import { DisableAgentInConversationUseCase } from '@core/application/conversations/disable-agent-in-conversation-use-case.js';

const iso = '2026-05-06T00:00:00.000Z';

function binding() {
  return {
    id: 'binding-1',
    appId: 'app-one',
    agentId: 'agent:one',
    providerConnectionId: 'providerConnection-1',
    conversationId: 'conversation-1',
    displayName: 'Engineering',
    status: 'active',
    triggerMode: 'always',
    requiresTrigger: false,
    isAdminBinding: false,
    memoryScope: 'conversation',
    memorySubject: {
      type: 'conversation',
      appId: 'app-one',
      conversationId: 'conversation-1',
    },
    permissionPolicyIds: [],
    createdAt: iso,
    updatedAt: iso,
  } as never;
}

describe('DisableAgentInConversationUseCase', () => {
  it('disables through the canonical binding repository contract', async () => {
    const active = binding();
    const disabled = { ...active, status: 'disabled', updatedAt: iso };
    const providerConnections = {
      disableAgentConversationBinding: vi.fn(async () => disabled),
    };
    const useCase = new DisableAgentInConversationUseCase({
      providerConnections: providerConnections as never,
      clock: { now: () => iso },
    });

    await expect(useCase.execute({ binding: active })).resolves.toEqual({
      binding: disabled,
    });
    expect(
      providerConnections.disableAgentConversationBinding,
    ).toHaveBeenCalledWith({
      appId: 'app-one',
      agentId: 'agent:one',
      conversationId: 'conversation-1',
      threadId: undefined,
      updatedAt: iso,
    });
  });

  it('returns a typed not-found error when the binding is gone', async () => {
    const useCase = new DisableAgentInConversationUseCase({
      providerConnections: {
        disableAgentConversationBinding: vi.fn(async () => null),
      } as never,
      clock: { now: () => iso },
    });

    await expect(useCase.execute({ binding: binding() })).rejects.toMatchObject(
      {
        code: 'NOT_FOUND',
      },
    );
  });
});
