import { describe, expect, it } from 'vitest';

import {
  CreateJobResponseSchema,
  JobResponseSchema,
  JobToolAccessSchema,
  RuntimeSettingsPublicSchema,
} from '@contracts-src/index.js';

// Harness-internal / provider-native field names that must never surface on a
// public control-API contract. These are execution-renderer projections or raw
// SDK permission knobs; the public surface only carries Gantry-owned names.
// Matched as EXACT keys, so legitimate public fields that merely contain a
// substring (e.g. `effectiveAllowedTools`) are not flagged.
const FORBIDDEN_PUBLIC_KEYS = [
  'allowedTools',
  'disallowedTools',
  'permissionMode',
  'executionProviderId',
  'harness',
  'mcpServers',
  'LocalShellBackend',
  'interrupt_on',
] as const;

function shapeKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

function expectNoForbiddenKeys(label: string, keys: string[]): void {
  for (const forbidden of FORBIDDEN_PUBLIC_KEYS) {
    expect(keys, `${label} must not expose ${forbidden}`).not.toContain(
      forbidden,
    );
  }
}

describe('public boundary leakage', () => {
  it('keeps harness/provider internals off the job response contract', () => {
    expectNoForbiddenKeys('JobResponseSchema', shapeKeys(JobResponseSchema));
    expectNoForbiddenKeys(
      'CreateJobResponseSchema',
      shapeKeys(CreateJobResponseSchema),
    );
  });

  it('exposes only Gantry tool-access projections, never raw SDK tool grants', () => {
    const keys = shapeKeys(JobToolAccessSchema);
    expectNoForbiddenKeys('JobToolAccessSchema', keys);
    // The public tool-access view is a fixed, Gantry-named allowlist.
    expect(keys.sort()).toEqual(
      [
        'effectiveAllowedTools',
        'inheritedAgentTools',
        'projectedRuntimeTools',
        'source',
      ].sort(),
    );
  });

  it('keeps harness/provider internals off the public settings contract', () => {
    const topLevel = shapeKeys(RuntimeSettingsPublicSchema);
    expectNoForbiddenKeys('RuntimeSettingsPublicSchema', topLevel);
    // The permissions block is the only place SDK-style knobs could creep in.
    const permissions = RuntimeSettingsPublicSchema.shape.permissions;
    expectNoForbiddenKeys(
      'RuntimeSettingsPublicSchema.permissions',
      shapeKeys(permissions),
    );
  });

  it('rejects a forbidden key on the strict job response contract', () => {
    // The shape guards above only hold because these schemas are `.strict()`;
    // assert the rejection directly so loosening to passthrough fails here too.
    const result = JobResponseSchema.safeParse({
      jobId: 'job-1',
      permissionMode: 'bypassPermissions',
    });
    expect(result.success).toBe(false);
  });
});
