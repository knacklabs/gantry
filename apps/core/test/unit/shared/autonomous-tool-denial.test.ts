import { describe, expect, it } from 'vitest';

import { parseAutonomousToolDenial } from '@core/shared/autonomous-tool-denial.js';

describe('parseAutonomousToolDenial', () => {
  it.each([
    [
      'Tool not on autonomous run allowlist: Browser. Recovery: request_access {"target":{"kind":"capability","id":"browser.use"},"temporaryOnly":false}',
      'Browser',
      'request_access {"target":{"kind":"capability","id":"browser.use"},"temporaryOnly":false}',
    ],
    [
      'Tool not on autonomous run allowlist: capability:acme.records.append. Recovery: request_access {"target":{"kind":"capability","id":"acme.records.append"},"reason":"This autonomous run requires capability:acme.records.append access."}',
      'capability:acme.records.append',
      'request_access {"target":{"kind":"capability","id":"acme.records.append"},"reason":"This autonomous run requires capability:acme.records.append access."}',
    ],
    [
      'Missing tool access requirement before run. Tool not on autonomous run allowlist: RunCommand(acme records append *). Recovery: request_access {"target":{"kind":"run_command","argvPattern":"acme records append *"},"temporaryOnly":false}',
      'RunCommand(acme records append *)',
      'request_access {"target":{"kind":"run_command","argvPattern":"acme records append *"},"temporaryOnly":false}',
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
