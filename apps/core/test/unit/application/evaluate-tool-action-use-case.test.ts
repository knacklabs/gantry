import { describe, expect, it } from 'vitest';

import { EvaluateToolActionUseCase } from '@core/application/tools/evaluate-tool-action-use-case.js';

const iso = '2026-05-06T00:00:00.000Z';

function useCase() {
  return new EvaluateToolActionUseCase({
    ids: { generate: () => 'decision-1' },
    clock: { now: () => iso },
  });
}

describe('EvaluateToolActionUseCase', () => {
  it('allows a tool through a selected durable capability rule', async () => {
    await expect(
      useCase().execute({
        appId: 'app-one' as never,
        toolName: 'Read',
        allowedToolRules: ['Read'],
      }),
    ).resolves.toMatchObject({
      decision: {
        id: 'permission-decision:decision-1',
        effect: 'allow',
        reason: 'Allowed by selected capability rule for Read.',
        actorContext: { toolName: 'Read' },
      },
    });
  });

  it('lets explicit deny rules override durable allows', async () => {
    await expect(
      useCase().execute({
        appId: 'app-one' as never,
        toolName: 'Bash',
        allowedToolRules: ['Bash'],
        deniedToolRules: ['Bash'],
      }),
    ).resolves.toMatchObject({
      decision: {
        effect: 'deny',
        reason: 'Denied by tool policy for Bash.',
      },
    });
  });

  it('honors unexpired transient approvals before durable policy checks', async () => {
    await expect(
      useCase().execute({
        appId: 'app-one' as never,
        toolName: 'Bash',
        deniedToolRules: ['Bash'],
        transientApprovals: [
          {
            toolName: 'Bash',
            approverRef: 'telegram:5759865942',
            expiresAt: '2026-05-06T00:05:00.000Z' as never,
          },
        ],
      }),
    ).resolves.toMatchObject({
      decision: {
        effect: 'allow',
        approverRef: 'telegram:5759865942',
      },
    });
  });

  it('requires sandbox or approval for matching policy rules', async () => {
    await expect(
      useCase().execute({
        appId: 'app-one' as never,
        toolName: 'Write',
        sandboxRequiredToolRules: ['Write'],
      }),
    ).resolves.toMatchObject({
      decision: { effect: 'require_sandbox' },
    });
    await expect(
      useCase().execute({
        appId: 'app-one' as never,
        toolName: 'mcp__github__search',
        approvalToolRules: ['mcp__github__*'],
      }),
    ).resolves.toMatchObject({
      decision: { effect: 'require_approval' },
    });
  });

  it('fails closed for missing or unknown tools', async () => {
    await expect(
      useCase().execute({
        appId: 'app-one' as never,
        toolName: 'Unknown',
      }),
    ).resolves.toMatchObject({
      decision: {
        effect: 'deny',
        reason: 'No matching permission rule for Unknown.',
      },
    });
    await expect(
      useCase().execute({
        appId: 'app-one' as never,
        toolName: '   ',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
