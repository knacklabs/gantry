import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bindPendingPermissionInteractionMessage,
  configurePendingInteractionDurability,
  pendingInteractionIdempotencyKey,
} from '@core/application/interactions/pending-interaction-durability.js';
import type { PermissionApprovalRequest } from '@core/domain/types.js';
import { requestDurableTaskPermissionApproval } from '@core/jobs/ipc-handler.js';

afterEach(() => {
  configurePendingInteractionDurability(null);
});

describe('reviewed-capability permission durability', () => {
  it.each([
    {
      flow: 'skill-install',
      requestId: 'skill-install-command-reviewed-test',
      toolName: 'request_skill_install',
    },
    {
      flow: 'mcp-server',
      requestId: 'mcp-reviewed-test',
      toolName: 'request_mcp_server',
    },
  ])(
    'records the $flow request with the key consumed by prompt binding',
    async ({ requestId, toolName }) => {
      const rows: any[] = [];
      const events: string[] = [];
      const bindPendingPermissionPrompt = vi.fn(async (input: any) => {
        const member = rows.find(
          (candidate) =>
            candidate.idempotencyKey === input.members[0]?.idempotencyKey,
        );
        return member ? { prompt: { id: input.id }, members: [member] } : null;
      });
      const repository = {
        createPendingInteraction: vi.fn(async (input: any) => {
          events.push('durable-record');
          const row = {
            ...input,
            status: 'pending',
            approverRef: null,
            resolution: null,
            createdAt: '2026-07-18T00:00:00.000Z',
            resolvedAt: null,
          };
          rows.push(row);
          return row;
        }),
        bindPendingPermissionPrompt,
      };
      configurePendingInteractionDurability({
        repository: repository as never,
      });
      const request: PermissionApprovalRequest = {
        requestId,
        appId: 'app:test' as never,
        agentId: 'agent:main_agent' as never,
        sourceAgentFolder: 'main_agent',
        targetJid: 'sl:C123',
        decisionPolicy: 'same_channel',
        decisionOptions: ['allow_once', 'cancel'],
        toolName,
        displayName: toolName,
        description: 'Reviewed capability request.',
        toolInput: {},
      };
      let bound = false;

      await requestDurableTaskPermissionApproval(request, async () => {
        events.push('prompt');
        bound = await bindPendingPermissionInteractionMessage({
          request,
          decisionOptions: ['allow_once', 'cancel'],
          callbackId: request.requestId,
          externalMessageId: 'prompt-1',
          provider: 'slack',
          conversationId: 'C123',
        });
        return { approved: false, mode: 'cancel' };
      });

      const expectedKey = pendingInteractionIdempotencyKey({
        kind: 'permission',
        sourceAgentFolder: request.sourceAgentFolder,
        requestId: request.requestId,
        appId: request.appId,
      });
      expect(repository.createPendingInteraction).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey: expectedKey }),
      );
      expect(bindPendingPermissionPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          members: [expect.objectContaining({ idempotencyKey: expectedKey })],
        }),
      );
      expect(events).toEqual(['durable-record', 'prompt']);
      expect(bound).toBe(true);
    },
  );

  it.each([
    ['request_skill_install', 'skill-install-record-failed'],
    ['request_mcp_server', 'mcp-record-failed'],
  ])(
    'withholds the %s prompt when its durable record fails',
    async (toolName, requestId) => {
      configurePendingInteractionDurability({
        repository: {
          createPendingInteraction: vi.fn(async () => {
            throw new Error('postgres unavailable');
          }),
        } as never,
      });
      const prompt = vi.fn();

      await expect(
        requestDurableTaskPermissionApproval(
          {
            requestId,
            appId: 'app:test' as never,
            agentId: 'agent:main_agent' as never,
            sourceAgentFolder: 'main_agent',
            targetJid: 'sl:C123',
            decisionPolicy: 'same_channel',
            decisionOptions: ['allow_once', 'cancel'],
            toolName,
            displayName: toolName,
            description: 'Reviewed capability request.',
            toolInput: {},
          },
          prompt,
        ),
      ).rejects.toThrow('postgres unavailable');
      expect(prompt).not.toHaveBeenCalled();
    },
  );
});
