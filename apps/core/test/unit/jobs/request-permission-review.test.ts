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

  it('stores scoped synthetic permission tools under namespaced ids without widening oversized rules', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      deps: depsWith(repository),
      sourceAgentFolder: 'agent:one',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
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

    expect(persisted).toEqual(['Bash(npm test *)']);
    expect(repository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^tool:permission-rule:/),
        name: 'Bash(npm test *)',
      }),
    );
    expect(repository.saveTool.mock.calls[0]?.[0].id).not.toBe('tool:Bash');
  });

  it('persists scoped Bash permission rules whose command contains parentheses', async () => {
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const ruleContent =
      'git -C ~/Workdir/myclaw log --format=%s --grep="fix(permissions)"';
    const persisted = await persistRequestPermissionRules({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      deps: {
        getToolRepository: () => repository as never,
        mirrorAgentToolRulesToSettings,
      },
      sourceAgentFolder: 'main_agent',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent }],
        },
      ],
    });

    const readableRule = `Bash(${ruleContent})`;
    expect(persisted).toEqual([readableRule]);
    expect(repository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: readableRule }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      [readableRule],
      { appId: 'app:test' },
    );
  });

  it('binds exact admin MCP tools without creating synthetic wildcard grants', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-admin-live-tool-rules-'),
    );
    const repository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__myclaw__service_restart',
        appId: 'app:test',
        status: 'active',
        selectable: true,
      })),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      deps: depsWith(repository),
      sourceAgentFolder: 'main_agent',
      ipcDir,
      runHandle: 'agent-run-1',
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
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(ipcDir, 'live-tool-rules', 'agent-run-1.json'),
          'utf-8',
        ),
      ),
    ).toEqual(['mcp__myclaw__service_restart']);
  });

  it('binds persistent Browser approvals to the catalog Browser tool and mirrors settings', async () => {
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => [
        {
          id: 'tool:Browser',
          appId: 'app:test',
          name: 'Browser',
          status: 'active',
          selectable: true,
        },
      ]),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      deps: {
        getToolRepository: () => repository as never,
        mirrorAgentToolRulesToSettings,
      },
      sourceAgentFolder: 'main_agent',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Browser' }],
        },
      ],
    });

    expect(persisted).toEqual(['Browser']);
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:test',
        toolId: 'tool:Browser',
        status: 'active',
      }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['Browser'],
      { appId: 'app:test' },
    );
  });

  it('rejects exact catalog approvals from a different app', async () => {
    const repository = {
      getTool: vi.fn(async () => ({
        id: 'tool:Browser',
        appId: 'default',
        status: 'active',
        selectable: true,
      })),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await expect(
      persistRequestPermissionRules({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Browser' }],
          },
        ],
      }),
    ).rejects.toThrow('unavailable for persistent approval');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('does not suggest persistent grants for raw agent_browser request_permission', () => {
    for (const toolName of [
      'mcp__agent_browser__navigate',
      'mcp__playwright__browser_click',
      'mcp__puppeteer__screenshot',
    ]) {
      expect(
        requestPermissionReviewSuggestions({
          permissionKind: 'tool',
          toolName,
          rule: 'url=https://example.com',
          temporaryOnly: false,
        }),
      ).toBeUndefined();
    }
  });

  it('does not suggest persistent grants for projected browser request_permission', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'mcp__myclaw__browser_click',
        temporaryOnly: false,
      }),
    ).toBeUndefined();
  });

  it('rejects raw agent_browser persistent approval updates', async () => {
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => [
        {
          id: 'tool:Browser',
          appId: 'app:test',
          name: 'Browser',
          status: 'active',
          selectable: true,
        },
      ]),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await expect(
      persistRequestPermissionRules({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        deps: {
          getToolRepository: () => repository as never,
          mirrorAgentToolRulesToSettings,
        },
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'mcp__playwright__browser_click' }],
          },
        ],
      }),
    ).rejects.toThrow('Raw browser backend MCP tools are host-private');

    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it('rejects projected browser tool persistent approval updates', async () => {
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await expect(
      persistRequestPermissionRules({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        deps: {
          getToolRepository: () => repository as never,
          mirrorAgentToolRulesToSettings,
        },
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'mcp__myclaw__browser_click' }],
          },
        ],
      }),
    ).rejects.toThrow('runtime projections, not durable capabilities');

    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it('binds canonical Browser persistent approval updates to Browser', async () => {
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => [
        {
          id: 'tool:Browser',
          appId: 'app:test',
          name: 'Browser',
          status: 'active',
          selectable: true,
        },
      ]),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      deps: {
        getToolRepository: () => repository as never,
        mirrorAgentToolRulesToSettings,
      },
      sourceAgentFolder: 'main_agent',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Browser' }],
        },
      ],
    });

    expect(persisted).toEqual(['Browser']);
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: 'tool:Browser' }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['Browser'],
      { appId: 'app:test' },
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
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
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
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        deps: { getToolRepository: () => repository as never },
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
          },
        ],
      }),
    ).rejects.toThrow('Settings mirror unavailable');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects broad scoped host-tool grants from chat approval', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    for (const [toolName, ruleContent] of [
      ['Bash', '*'],
      ['Read', '**'],
      ['Write', '/**'],
    ] as const) {
      await expect(
        persistRequestPermissionRules({
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
          deps: depsWith(repository),
          sourceAgentFolder: 'main_agent',
          updates: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName, ruleContent }],
            },
          ],
        }),
      ).rejects.toThrow('Broad persistent host-tool grants');
    }
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
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
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
            rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
          },
        ],
      }),
    ).rejects.toThrow('settings write failed');
    expect(repository.saveAgentToolBinding).toHaveBeenCalledOnce();
    expect(repository.disableAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:test',
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
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
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
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
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
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
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
