import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  persistRequestPermissionRules,
  requestPermissionReviewSuggestions,
} from '@core/jobs/request-permission-review.js';

function depsWith(repository: unknown) {
  return {
    getToolRepository: () => repository as never,
    mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
  };
}

describe('request permission review helpers', () => {
  it('does not suggest persistent tool grants for temporary, non-tool, multi-tool, or oversized rules', () => {
    expect(
      requestPermissionReviewSuggestions({
        temporaryOnly: true,
        toolName: 'Bash',
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'provider_capability',
        toolName: 'Bash',
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolNames: ['Bash', 'Write'],
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'x'.repeat(2049),
      }),
    ).toBeUndefined();
  });

  it('stores synthetic permission tools under namespaced ids without widening oversized rules', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      deps: depsWith(repository),
      sourceAgentFolder: 'agent:one',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash' }],
        },
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            {
              toolName: 'Write',
              ruleContent: 'x'.repeat(2049),
            },
          ],
        },
      ],
    });

    expect(persisted).toEqual(['Bash']);
    expect(repository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^tool:permission-rule:/),
        name: 'Bash',
      }),
    );
    expect(repository.saveTool.mock.calls[0]?.[0].id).not.toBe('tool:Bash');
  });

  it('binds exact admin MCP tools without creating synthetic wildcard grants', async () => {
    const repository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__myclaw__service_restart',
        status: 'active',
        selectable: true,
      })),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      deps: depsWith(repository),
      sourceAgentFolder: 'main_agent',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'mcp__myclaw__service_restart' }],
        },
      ],
    });

    expect(persisted).toEqual(['mcp__myclaw__service_restart']);
    expect(repository.getTool).toHaveBeenCalledWith(
      'tool:mcp__myclaw__service_restart',
    );
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'tool:mcp__myclaw__service_restart',
        status: 'active',
      }),
    );
  });

  it('writes approved persistent rules to the current run live permission file', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-live-tool-rules-'),
    );
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      deps: depsWith(repository),
      sourceAgentFolder: 'main_agent',
      ipcDir,
      runHandle: 'agent-run-1',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        },
      ],
    });

    expect(persisted).toEqual(['Bash(npm test *)']);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(ipcDir, 'live-tool-rules', 'agent-run-1.json'),
          'utf-8',
        ),
      ),
    ).toEqual(['Bash(npm test *)']);
  });

  it('fails closed when persistent settings mirror is unavailable', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await expect(
      persistRequestPermissionRules({
        deps: { getToolRepository: () => repository as never },
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Bash' }],
          },
        ],
      }),
    ).rejects.toThrow('Settings mirror unavailable');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rolls back active bindings when persistent settings mirror fails', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-live-tool-rules-rollback-'),
    );
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => {
      throw new Error('settings write failed');
    });

    await expect(
      persistRequestPermissionRules({
        deps: {
          getToolRepository: () => repository as never,
          mirrorAgentToolRulesToSettings,
        },
        sourceAgentFolder: 'main_agent',
        ipcDir,
        runHandle: 'agent-run-1',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Bash' }],
          },
        ],
      }),
    ).rejects.toThrow('settings write failed');
    expect(repository.saveAgentToolBinding).toHaveBeenCalledOnce();
    expect(repository.disableAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:main_agent',
        toolId: expect.stringMatching(/^tool:permission-rule:/),
      }),
    );
    expect(
      fs.existsSync(path.join(ipcDir, 'live-tool-rules', 'agent-run-1.json')),
    ).toBe(false);
  });

  it('rejects persistent MyClaw MCP wildcard approvals', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await expect(
      persistRequestPermissionRules({
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'mcp__myclaw__*' }],
          },
        ],
      }),
    ).rejects.toThrow('wildcard grants are not supported');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects scoped persistent MyClaw MCP wildcard approvals', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await expect(
      persistRequestPermissionRules({
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              {
                toolName: 'mcp__myclaw__*',
                ruleContent: 'service_restart',
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('wildcard grants are not supported');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects scoped persistent admin MCP tool approvals', async () => {
    const repository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__myclaw__service_restart',
        status: 'active',
        selectable: true,
      })),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await expect(
      persistRequestPermissionRules({
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              {
                toolName: 'mcp__myclaw__service_restart',
                ruleContent: 'reason=test',
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('exact tool name without a scoped rule');
    expect(repository.getTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });
});
