import { describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  writeIpcFile: vi.fn(),
  waitForTaskResponse: vi.fn(async () => ({
    ok: true,
    data: { stdout: 'replayed', stderr: '' },
  })),
}));

vi.hoisted(() => {
  process.env.GANTRY_IPC_DIR ??= '/tmp/gantry-capability-catalog-replay';
});

vi.mock('@core/runner/mcp/ipc.js', () => ipc);

import { resolveAgentPromptCapabilityCatalog } from '@core/application/agents/agent-prompt-capability-catalog.js';
import { PromptProfileService } from '@core/application/agents/prompt-profile-service.js';
import { selectedGantryMcpFullToolNames } from '@core/runner/gantry-mcp-tool-surface.js';
import { registerCapabilityRunTool } from '@core/runner/mcp/tools/capability-run.js';
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

class TestMcpServer {
  readonly tools = new Map<
    string,
    (input: Record<string, unknown>) => Promise<unknown>
  >();

  tool(
    name: string,
    _description: string,
    _schema: unknown,
    handler: (input: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.tools.set(name, handler);
  }
}

async function materializeAndReplay(includeDescriptor: boolean) {
  ipc.writeIpcFile.mockClear();
  ipc.waitForTaskResponse.mockClear();
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
  const invocation = catalog.readyActions[0]?.invocations?.find(
    (candidate) => candidate.kind === 'local_cli',
  );
  const server = new TestMcpServer();
  registerCapabilityRunTool(server as never);
  if (
    invocation?.kind === 'local_cli' &&
    projectedTools.includes(`mcp__gantry__${invocation.toolRef}`)
  ) {
    await server.tools.get(invocation.toolRef)?.({
      capabilityId: invocation.capabilityId,
      args: JSON.parse(invocation.argumentPatterns[0] ?? '[]'),
    });
  }
  return { catalog, prompt, projectedTools };
}

describe('recorded capability catalog replay', () => {
  it('the granted capability is the first tool action in replay', async () => {
    const replay = await materializeAndReplay(true);

    expect(replay.projectedTools).toContain('mcp__gantry__capability_run');
    expect(ipc.writeIpcFile).toHaveBeenCalledTimes(1);
    expect(ipc.writeIpcFile.mock.calls[0]?.[1]).toMatchObject({
      type: 'capability_run',
      payload: {
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
    expect(replay.prompt).not.toContain('invoke: mcp__gantry__capability_run');
    expect(ipc.writeIpcFile).not.toHaveBeenCalled();
  });
});
