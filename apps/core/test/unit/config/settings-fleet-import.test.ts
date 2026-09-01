import { describe, expect, it } from 'vitest';

import { partitionStoredRuleCapabilityErrors } from '@core/config/settings/settings-fleet-import.js';

describe('partitionStoredRuleCapabilityErrors', () => {
  it('demotes stored RunCommand grant rejections to warnings and keeps other errors hard', () => {
    const { hardErrors, warnings } = partitionStoredRuleCapabilityErrors([
      'agents.main_agent.capabilities contains invalid capability "RunCommand(npx remotion *)": Bash npx wildcard scopes are too broad for persistent approval; use an exact command or a semantic capability.',
      'agents.main_agent.capabilities contains unavailable capability RunCommand(npx remotion render *): Capability id must use lowercase dot-separated words such as app.resource.action.',
      'agents.main_agent.capabilities contains unavailable capability google.sheets.nonexistent: unknown capability.',
      'memory.dreaming.enabled requires memory.enabled=true.',
    ]);
    expect(warnings).toHaveLength(2);
    expect(hardErrors).toEqual([
      'agents.main_agent.capabilities contains unavailable capability google.sheets.nonexistent: unknown capability.',
      'memory.dreaming.enabled requires memory.enabled=true.',
    ]);
  });

  it('returns everything hard when no stored rule entries are present', () => {
    const { hardErrors, warnings } = partitionStoredRuleCapabilityErrors([
      'agents.main_agent.model is invalid: nope',
    ]);
    expect(warnings).toEqual([]);
    expect(hardErrors).toHaveLength(1);
  });
});
