import { describe, expect, it } from 'vitest';

import { parseAutonomousToolDenial } from '@core/shared/autonomous-tool-denial.js';

describe('parseAutonomousToolDenial', () => {
  it.each([
    [
      'Tool not on autonomous run allowlist: Browser. Recovery: request_permission {"toolName":"Browser"}',
      'Browser',
      'request_permission {"toolName":"Browser"}',
    ],
    [
      'Tool not on autonomous run allowlist: capability:google.sheets.write. Recovery: propose_capability {"capabilityId":"google.sheets.write","reason":"This autonomous run requires capability:google.sheets.write access."}',
      'capability:google.sheets.write',
      'propose_capability {"capabilityId":"google.sheets.write","reason":"This autonomous run requires capability:google.sheets.write access."}',
    ],
    [
      'Missing tool access requirement before run. Tool not on autonomous run allowlist: RunCommand(gog sheets append *). Recovery: request_permission {"toolName":"RunCommand","rule":"gog sheets append *"}',
      'RunCommand(gog sheets append *)',
      'request_permission {"toolName":"RunCommand","rule":"gog sheets append *"}',
    ],
    [
      'Permission denied for Bash. Tool not on autonomous run allowlist: RunCommand. Bash leaf ls scripts did not match any scoped autonomous rule.',
      'RunCommand',
      undefined,
    ],
  ])('preserves the denied tool rule in %s', (summary, toolName, recovery) => {
    expect(parseAutonomousToolDenial(summary)).toEqual({
      toolName,
      ...(recovery ? { recoveryAction: recovery } : {}),
    });
  });
});
