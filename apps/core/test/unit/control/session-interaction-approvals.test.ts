import { describe, expect, it, vi } from 'vitest';

const repository = vi.hoisted(() => ({
  findPendingInteractionByRequest: vi.fn(),
  findPendingPermissionPromptByMember: vi.fn(),
  findPendingPermissionPrompt: vi.fn(),
  claimPendingPermissionCallback: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getWorkerCoordinationRepository: () => repository,
}));

import {
  respondToSessionPermissionInteraction,
  SESSION_INTERACTION_DECISIONS,
} from '@core/control/server/session-interaction-approvals.js';
import type { SessionAppRecord } from '@core/application/sessions/session-interaction-module.js';

describe('session interaction approvals', () => {
  it('renders a remember code as its scalar base in the control API and rejects a code on its POST', async () => {
    const request = {
      requestId: 'permission-one',
      appId: 'app-one',
      sourceAgentFolder: 'main_agent',
      targetJid: 'app:app-one:conversation-one',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    };
    const row = {
      id: 'pending-one',
      appId: 'app-one',
      runId: null,
      sourceAgentFolder: 'main_agent',
      requestId: 'permission-one',
      runLeaseToken: null,
      runLeaseFencingVersion: null,
      envelopeId: 'prompt-one',
      memberIndex: 0,
      kind: 'permission',
      status: 'pending',
      payload: { request },
      callbackRoute: null,
      idempotencyKey: 'app-one:permission:main_agent:permission-one',
      approverRef: null,
      resolution: null,
      createdAt: '2026-09-07T00:00:00.000Z',
      expiresAt: '2099-09-07T00:00:00.000Z',
      resolvedAt: null,
    };
    const group = {
      prompt: {
        interactionId: 'permission-one',
        matchKind: 'individual',
        envelope: { renderedDecisionOptions: ['remember_allow_exact'] },
      },
      members: [row],
    };
    repository.findPendingInteractionByRequest.mockResolvedValue(row);
    repository.findPendingPermissionPromptByMember.mockResolvedValue(group);
    const session: SessionAppRecord = {
      sessionId: 'session-one',
      appId: 'app-one',
      agentId: 'main_agent',
      conversationId: 'conversation-one',
      canonicalConversationId: 'conversation-one',
      conversationJid: 'app:app-one:conversation-one',
      workspaceKey: 'main_agent',
      defaultResponseMode: 'sync',
      defaultWebhookId: null,
    };

    await expect(
      respondToSessionPermissionInteraction({
        session,
        interactionId: 'permission-one',
        decision: 'allow_future',
        decidedBy: 'api-key:test',
      }),
    ).resolves.toEqual({
      status: 'option_unavailable',
      options: ['allow_once'],
    });
    expect(SESSION_INTERACTION_DECISIONS).not.toContain('remember_allow_exact');
    await expect(
      respondToSessionPermissionInteraction({
        session,
        interactionId: 'permission-one',
        decision: 'remember_allow_exact' as never,
        decidedBy: 'api-key:test',
      }),
    ).resolves.toEqual({
      status: 'option_unavailable',
      options: ['allow_once'],
    });
    expect(repository.claimPendingPermissionCallback).not.toHaveBeenCalled();
  });
});
