import { describe, expect, it } from 'vitest';

import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import {
  replayPermissionRequest,
  TAP_BUDGET_WORKSPACE_ROOT,
} from './askfloor-tap-budget-harness.js';

const FAILURE_CODES = [
  'llm_unconfigured',
  'timeout',
  'model_resolution_failure',
  'query_error',
  'parse_failure',
  'validation_failure',
  'wiring_missing',
] as const;

const base = {
  workspaceRoot: TAP_BUDGET_WORKSPACE_ROOT,
  trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
  classifierVerdict: {
    risk_level: 'high' as const,
    risk_category: 'network' as const,
    reason: 'The judge requires approval.',
  },
};

describe('ASKFLOOR judge invariance', () => {
  it('keeps every lane tuple unchanged under an answering judge and under an unavailable judge for the six codes and wiring_missing except the interactive-auto ask and its offline reason', async () => {
    const fixtures = [
      { label: 'ask', permissionMode: 'ask' as const },
      { label: 'auto_strict', permissionMode: 'auto_strict' as const },
      {
        label: 'trusted-host autonomous projection quartet',
        permissionMode: 'auto' as const,
        hostJobId: 'job-invariance',
      },
      {
        label: 'YOLO backstop',
        permissionMode: 'auto' as const,
        toolName: 'mcp__gantry__scheduler_delete_job',
        toolInput: { jobId: 'job-1' },
      },
      {
        label: 'unmapped-forced-ask',
        permissionMode: 'auto' as const,
        toolName: 'mcp__gantry__frobnicate_everything',
        toolInput: {},
      },
      {
        label: 'scheduler-admin-destructive family rail hit',
        permissionMode: 'auto' as const,
        command: 'rm -rf build',
      },
    ];

    for (const fixture of fixtures) {
      const answered = await replayPermissionRequest({
        ...base,
        ...fixture,
        toolName: fixture.toolName ?? 'mcp__crm__update_record',
        toolInput: fixture.toolInput ?? { id: fixture.label },
        classifierVerdict: {
          ...base.classifierVerdict,
          status: PermissionClassifierStatus.Answered,
        },
      });
      for (const failureCode of FAILURE_CODES) {
        const unavailable = await replayPermissionRequest({
          ...base,
          ...fixture,
          toolName: fixture.toolName ?? 'mcp__crm__update_record',
          toolInput: fixture.toolInput ?? { id: fixture.label },
          classifierVerdict: {
            ...base.classifierVerdict,
            status: PermissionClassifierStatus.Unavailable,
            reason: `Classifier unavailable (${failureCode}); ask the user.`,
          },
          ...(failureCode === 'wiring_missing'
            ? { publishRuntimeEvent: false }
            : {}),
        });
        expect(unavailable, `${fixture.label}:${failureCode}`).toEqual(
          answered,
        );
      }
    }
  });

  it('keeps the inline-scheduled path and the attachment_open birthright unchanged under an unavailable judge', async () => {
    const unavailable = {
      ...base.classifierVerdict,
      status: PermissionClassifierStatus.Unavailable,
      reason: 'Classifier unavailable (query_error); ask the user.',
    };
    await expect(
      replayPermissionRequest({
        ...base,
        permissionMode: 'auto',
        toolName: 'mcp__gantry__attachment_open',
        toolInput: { attachment_ids: ['attachment-1'] },
        attachmentOpenIds: { wellFormed: true, count: 1 },
        classifierVerdict: unavailable,
      }),
    ).resolves.toMatchObject({ taps: 0, decidedBy: 'birthright' });
    await expect(
      replayPermissionRequest({
        ...base,
        permissionMode: 'auto',
        hostJobId: 'job-inline-scheduled',
        toolName: 'mcp__crm__update_record',
        toolInput: { id: 'scheduled' },
        classifierVerdict: unavailable,
      }),
    ).resolves.toMatchObject({ taps: 1, decidedBy: 'owner' });
  });
});
