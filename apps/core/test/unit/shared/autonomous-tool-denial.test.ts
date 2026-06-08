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
      'Tool not on autonomous run allowlist: capability:acme.records.append. Recovery: propose_capability {"capabilityId":"acme.records.append","reason":"This autonomous run requires capability:acme.records.append access."}',
      'capability:acme.records.append',
      'propose_capability {"capabilityId":"acme.records.append","reason":"This autonomous run requires capability:acme.records.append access."}',
    ],
    [
      'Missing tool access requirement before run. Tool not on autonomous run allowlist: RunCommand(acme records append *). Recovery: request_permission {"toolName":"RunCommand","rule":"acme records append *"}',
      'RunCommand(acme records append *)',
      'request_permission {"toolName":"RunCommand","rule":"acme records append *"}',
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
