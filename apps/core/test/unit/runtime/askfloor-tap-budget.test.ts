import { describe, expect, it } from 'vitest';

import {
  replayPermissionRequest,
  TAP_BUDGET_WORKSPACE_ROOT,
} from './askfloor-tap-budget-harness.js';

describe('ASKFLOOR tap budget', () => {
  it('S1: opening an attachment already in the conversation costs 0 taps in every lane with the typed fact carried by the fixture', async () => {
    for (const lane of [
      { permissionMode: 'ask' as const },
      { permissionMode: 'auto' as const },
      { permissionMode: 'auto_strict' as const },
      { permissionMode: 'auto' as const, hostJobId: 'job-attachment-open' },
    ]) {
      await expect(
        replayPermissionRequest({
          ...lane,
          toolName: 'mcp__gantry__attachment_open',
          toolInput: { attachment_ids: ['attachment-1'] },
          attachmentOpenIds: { wellFormed: true, count: 1 },
          trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
          classifierVerdict: {
            risk_level: 'high',
            reason: 'The classifier must not run for a birthright.',
          },
        }),
      ).resolves.toEqual({
        taps: 0,
        decidedBy: 'birthright',
        source: 'birthright',
        railProvenance: null,
      });
    }
  });

  it('S3: 2>/dev/null and read-only find cost 0 taps in interactive auto', async () => {
    const classifierVerdict = {
      risk_level: 'low' as const,
      risk_category: 'benign' as const,
      reason: 'Classifier allows this read.',
    };
    const stderrRedirect = await replayPermissionRequest({
      permissionMode: 'auto',
      command: 'git status 2>/dev/null',
      trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
      classifierVerdict,
    });
    const readOnlyFind = await replayPermissionRequest({
      permissionMode: 'auto',
      command: "find . -name '*.ts'",
      trustedRoots: [TAP_BUDGET_WORKSPACE_ROOT],
      classifierVerdict,
    });

    expect(stderrRedirect).toMatchObject({
      taps: 0,
      decidedBy: 'auto_classifier',
      source: 'auto_classifier',
      railProvenance: null,
    });
    expect(readOnlyFind).toMatchObject({
      taps: 0,
      decidedBy: 'auto_classifier',
      source: 'auto_classifier',
      railProvenance: { signal: 'unsupported_meta_executor' },
    });
  });
});
