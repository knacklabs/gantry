import { describe, expect, it } from 'vitest';

import type { AgentAccessSnapshot } from '@core/application/agent-execution/agent-access-snapshot.js';
import { resolveTurnToolPolicyFromSnapshot } from '@core/runtime/group-run-context.js';

describe('acting identity', () => {
  it('absent personId resolves shared-only', () => {
    const snapshot = accessSnapshot();

    expect(resolveTurnToolPolicyFromSnapshot(snapshot).toolPolicyRules).toEqual(
      ['WebSearch'],
    );
    expect(
      resolveTurnToolPolicyFromSnapshot(snapshot, 'person:alice')
        .toolPolicyRules,
    ).toEqual(['WebSearch', 'FileRead']);
    expect(
      resolveTurnToolPolicyFromSnapshot(snapshot, 'person:bob').toolPolicyRules,
    ).toEqual(['WebSearch', 'FileWrite']);
  });
});

function accessSnapshot(): AgentAccessSnapshot {
  const rows = [
    binding('tool:shared', 'WebSearch', null),
    binding('tool:alice', 'FileRead', 'person:alice'),
    binding('tool:bob', 'FileWrite', 'person:bob'),
  ];
  return {
    appId: 'app:test',
    agentId: 'agent:test',
    tools: { activeBindings: rows, appActiveDefinitions: [] },
    skills: { activeBindings: [], enabledDefinitions: [] },
    mcp: { activeBindings: [], materializedServers: [] },
  } as unknown as AgentAccessSnapshot;
}

function binding(toolId: string, name: string, personId: string | null) {
  return {
    binding: {
      id: `binding:${toolId}:${personId ?? 'shared'}`,
      appId: 'app:test',
      agentId: 'agent:test',
      toolId,
      personId,
      status: 'active',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    },
    definition: { appId: 'app:test', name },
  };
}
