import { describe, expect, it } from 'vitest';

import { PermissionClassifierStatus } from '@core/domain/permission-classifier-status.js';
import {
  replayDestructiveExactMemory,
  replayPermissionRequest,
  replayRememberedJobProjection,
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

const tuple = (
  result: Awaited<ReturnType<typeof replayPermissionRequest>>,
) => ({
  taps: result.taps,
  decidedBy: result.decidedBy,
  source: result.source,
  railProvenance: result.railProvenance,
});

describe('ASKFLOOR judge invariance', () => {
  it('keeps every lane tuple unchanged under an answering judge and under an unavailable judge for the six codes and wiring_missing except the interactive-auto ask and its offline reason', async () => {
    const fixtures = [
      { label: 'ask', permissionMode: 'ask' as const },
      { label: 'auto_strict', permissionMode: 'auto_strict' as const },
      { label: 'interactive_auto', permissionMode: 'auto' as const },
      {
        label: 'trusted-host autonomous',
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
      const request = {
        ...base,
        ...fixture,
        toolName: fixture.toolName ?? 'mcp__crm__lookup',
        toolInput: fixture.toolInput ?? { id: fixture.label },
      };
      const answered = await replayPermissionRequest({
        ...request,
        classifierVerdict: {
          ...base.classifierVerdict,
          status: PermissionClassifierStatus.Answered,
        },
      });
      for (const failureCode of FAILURE_CODES) {
        const unavailable = await replayPermissionRequest({
          ...request,
          classifierVerdict: {
            ...base.classifierVerdict,
            status: PermissionClassifierStatus.Unavailable,
            failureCode,
            reason: `Classifier unavailable (${failureCode}); ask the user.`,
          },
          ...(failureCode === 'wiring_missing'
            ? { publishRuntimeEvent: false }
            : {}),
        });
        expect(tuple(unavailable), `${fixture.label}:${failureCode}`).toEqual(
          tuple(answered),
        );
        if (
          fixture.label === 'interactive_auto' ||
          fixture.label === 'trusted-host autonomous'
        ) {
          expect(unavailable.decisionReason).toBe(
            'Asking because my safety judge is offline.',
          );
        }
      }
    }

    const answeredProjection = await replayRememberedJobProjection();
    const unavailableProjection = await replayRememberedJobProjection({
      classifierConsult: async () => ({
        status: PermissionClassifierStatus.Unavailable,
        risk_level: 'high',
        reason: 'Judge offline.',
        failureCode: 'query_error',
        latencyMs: 1,
      }),
    });
    expect(unavailableProjection).toMatchObject({
      chatTaps: answeredProjection.chatTaps,
      jobTaps: answeredProjection.jobTaps,
      revoked: answeredProjection.revoked,
    });

    const answeredDestructive = await replayDestructiveExactMemory();
    const unavailableDestructive = await replayDestructiveExactMemory({
      classifierConsult: async () => ({
        status: PermissionClassifierStatus.Unavailable,
        risk_level: 'high',
        reason: 'Judge offline.',
        failureCode: 'query_error',
        latencyMs: 1,
      }),
    });
    expect(unavailableDestructive.taps).toEqual(answeredDestructive.taps);
  });

  it('keeps the inline-scheduled path and the attachment_open birthright unchanged under an unavailable judge', async () => {
    const unavailable = {
      ...base.classifierVerdict,
      status: PermissionClassifierStatus.Unavailable,
      reason: 'Classifier unavailable (query_error); ask the user.',
      failureCode: 'query_error' as const,
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
        toolName: 'mcp__crm__lookup',
        toolInput: { id: 'scheduled' },
        classifierVerdict: unavailable,
      }),
    ).resolves.toMatchObject({
      taps: 1,
      decidedBy: 'owner',
      decisionReason: 'Asking because my safety judge is offline.',
    });
  });
});
