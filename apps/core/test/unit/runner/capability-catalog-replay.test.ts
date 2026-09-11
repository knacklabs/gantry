import { describe, expect, it } from 'vitest';

import { resolveAgentPromptCapabilityCatalog } from '@core/application/agents/agent-prompt-capability-catalog.js';
import { PromptProfileService } from '@core/application/agents/prompt-profile-service.js';
import { selectedGantryMcpFullToolNames } from '@core/runner/gantry-mcp-tool-surface.js';
import { DEFAULT_AGENT_ENGINE } from '@core/shared/agent-engine.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

const RECORDED_SHEETS_FIXTURE: SemanticCapabilityDefinition = {
  capabilityId: 'google.sheets.values.get',
  version: '1',
  displayName: 'Read sheet values',
  category: 'Sheets',
  risk: 'read',
  can: 'Read a reviewed spreadsheet range.',
  cannot: 'Write spreadsheet values.',
  credentialSource: 'local_cli',
  implementationBindings: [
    {
      kind: 'local_cli',
      executablePath: '/opt/gantry/bin/gws',
      executableVersion: '1.0.0',
      executableHash: 'sha256:reviewed',
      commandTemplates: ['/opt/gantry/bin/gws sheets values get *'],
    },
  ],
};

async function materializeAndReplay(includeDescriptor: boolean) {
  const catalog = resolveAgentPromptCapabilityCatalog({
    appId: 'app-one',
    agentId: 'agent-one',
    readySemanticCapabilities: [RECORDED_SHEETS_FIXTURE],
  });
  if (!includeDescriptor) delete catalog.readyActions[0]?.invocations;
  const prompt = await new PromptProfileService().compileSystemPrompt({
    agentFolder: 'scheduler',
    capabilityCatalog: catalog,
    agentEngine: DEFAULT_AGENT_ENGINE,
  });
  const projectedTools = selectedGantryMcpFullToolNames([], {
    excludeAuthorityTools: true,
    keepRecoveryProposals: true,
    permissionLane: 'autonomous',
  });
  const dispatcher = 'mcp__gantry__capability_run';
  const firstAction =
    projectedTools.includes(dispatcher) &&
    prompt.includes(`invoke: ${dispatcher}`)
      ? {
          toolName: dispatcher,
          input: {
            capabilityId: RECORDED_SHEETS_FIXTURE.capabilityId,
            args: ['sheets', 'values', 'get', '*'],
          },
        }
      : undefined;
  return { catalog, projectedTools, firstAction };
}

describe('recorded capability catalog replay', () => {
  it('the granted capability is the first tool action in replay', async () => {
    const replay = await materializeAndReplay(true);

    expect(replay.projectedTools).toContain('mcp__gantry__capability_run');
    expect(replay.firstAction).toEqual({
      toolName: 'mcp__gantry__capability_run',
      input: {
        capabilityId: 'google.sheets.values.get',
        args: ['sheets', 'values', 'get', '*'],
      },
    });
  });

  it('removing the descriptor stops the replay producing that call', async () => {
    const replay = await materializeAndReplay(false);

    expect(replay.catalog.readyActions[0]?.stableRef).toBe(
      'google.sheets.values.get',
    );
    expect(replay.firstAction).toBeUndefined();
  });
});
