import { describe, expect, it } from 'vitest';

import {
  replayPermissionRequest,
  TAP_BUDGET_WORKSPACE_ROOT,
} from './askfloor-tap-budget-harness.js';

describe('ASKFLOOR tap budget', () => {
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
