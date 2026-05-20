import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  formatPersistentPermissionRulesForUser,
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
  it('does not suggest persistent tool grants for temporary, non-tool, or multi-tool requests', () => {
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
        toolName: 'SandboxNetworkAccess',
      }),
    ).toBeUndefined();
  });

  it('suggests semantic capability grants by capability id', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        capabilityId: 'google.sheets.write',
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:google.sheets.write' }],
      },
    ]);
  });

  it('prefers explicit scoped Bash permission over capability metadata on setup requests', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolNames: ['Bash'],
        rule: '/usr/local/bin/gog sheets append *',
        capabilityId: 'google.sheets.write',
        capabilityDisplayName: 'Google Sheets write using gog',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          {
            toolName: 'Bash',
            ruleContent: '/usr/local/bin/gog sheets append *',
          },
        ],
      },
    ]);
  });

  it('canonicalizes interpreter script requests to script-path scoped Bash rules', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'python3 /Users/example/scripts/dedup-append-lead.py *',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          {
            toolName: 'Bash',
            ruleContent: '/Users/example/scripts/dedup-append-lead.py *',
          },
        ],
      },
    ]);

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'python3 /Users/example/scripts/dedup-append-lead.py',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          {
            toolName: 'Bash',
            ruleContent: '/Users/example/scripts/dedup-append-lead.py *',
          },
        ],
      },
    ]);
  });

  it('treats local CLI capability proposals as review-only drafts until runtime enforcement exists', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      listAgentToolBindings: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const toolInput = {
      capabilityId: 'acme.invoices.read',
      capabilityDisplayName: 'Acme invoices read',
      category: 'Acme',
      risk: 'read',
      accountLabel: 'Acme sandbox',
      can: 'Read invoice records.',
      cannot: 'Write invoices or export tokens.',
      credentialSource: 'local_cli',
      executablePath: '/usr/local/bin/acme',
      executableVersion: '1.2.3',
      executableHash: 'sha256:abc123',
      commandTemplates: ['/usr/local/bin/acme invoices read *'],
      authPreflightCommand: '/usr/local/bin/acme auth status',
      protectedPaths: ['~/.config/acme'],
    };

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        temporaryOnly: false,
        ...toolInput,
      }),
    ).toBeUndefined();

    await expect(
      persistRequestPermissionRules({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        toolInput,
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:acme.invoices.read' }],
          },
        ],
      }),
    ).rejects.toThrow('Local CLI capabilities are draft-only');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('does not let local CLI proposals for built-in capabilities become configured-access grants', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      listAgentToolBindings: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const toolInput = {
      capabilityId: 'google.sheets.write',
      capabilityDisplayName: 'Google Sheets write using gog',
      category: 'Google Sheets',
      risk: 'write',
      accountLabel: 'gog',
      can: 'Append rows using gog.',
      cannot: 'Use configured broker Google access.',
      credentialSource: 'local_cli',
      executablePath: '/usr/local/bin/gog',
      executableVersion: '1.2.3',
      executableHash: 'sha256:gog',
      commandTemplates: ['/usr/local/bin/gog sheets append *'],
    };

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        temporaryOnly: false,
        ...toolInput,
      }),
    ).toBeUndefined();

    await expect(
      persistRequestPermissionRules({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        toolInput,
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:google.sheets.write' }],
          },
        ],
      }),
    ).rejects.toThrow('Local CLI capabilities are draft-only');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects rebinding existing local CLI catalog rows through request_permission', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => [
        {
          id: 'tool:capability:acme.invoices.read',
          appId: 'app:test',
          name: 'capability:acme.invoices.read',
          kind: 'local_cli',
          status: 'active',
          selectable: true,
          inputSchema: {
            format: 'gantry.semantic-capability.v1',
            schema: {
              capabilityId: 'acme.invoices.read',
              displayName: 'Acme invoices read',
              category: 'Acme',
              risk: 'read',
              can: 'Read invoice records.',
              cannot: 'Write invoices.',
              credentialSource: 'local_cli',
              implementationBindings: [
                {
                  kind: 'local_cli',
                  executablePath: '/usr/local/bin/acme',
                  executableVersion: '1.2.3',
                  executableHash: 'sha256:abc123',
                  commandTemplates: ['/usr/local/bin/acme invoices read *'],
                },
              ],
              protectedPaths: ['~/.config/acme'],
            },
          },
        },
      ]),
      listAgentToolBindings: vi.fn(async () => []),
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
            rules: [{ toolName: 'capability:acme.invoices.read' }],
          },
        ],
      }),
    ).rejects.toThrow('Local CLI capabilities are draft-only');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('stores scoped Bash permission rules as synthetic permission tools', async () => {
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
      ],
    });

    expect(persisted).toEqual(['Bash(npm test *)']);
    expect(repository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^tool:permission-rule:/),
        name: 'Bash(npm test *)',
      }),
    );
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: expect.stringMatching(/^tool:permission-rule:/),
      }),
    );
  });

  it('persists scoped Bash permission when SDK command content contains parentheses', async () => {
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const ruleContent =
      'git -C ~/Workdir/gantry log --format=%s --grep="fix(permissions)"';
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
      path.join(os.tmpdir(), 'gantry-admin-live-tool-rules-'),
    );
    const repository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__gantry__service_restart',
        appId: 'app:test',
        status: 'active',
        selectable: true,
      })),
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
          rules: [{ toolName: 'mcp__gantry__service_restart' }],
        },
      ],
    });

    expect(persisted).toEqual(['mcp__gantry__service_restart']);
    expect(repository.getTool).toHaveBeenCalledWith(
      'tool:mcp__gantry__service_restart',
    );
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'tool:mcp__gantry__service_restart',
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
    ).toEqual(['mcp__gantry__service_restart']);
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
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => [
        {
          id: 'tool:Browser',
          appId: 'default',
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
    ).rejects.toThrow('unavailable');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('does not suggest persistent grants for raw host-private browser request_permission', () => {
    for (const toolName of [
      'mcp__browser' + '_' + 'backend' + '__navigate',
      'mcp__browser' + '_' + 'backend' + '__click',
      'mcp__browser' + '_' + 'backend' + '__screenshot',
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

  it('canonicalizes projected browser request_permission to Browser', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'mcp__gantry__browser_act',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Browser' }],
      },
    ]);
  });

  it('suggests persistent scoped Bash request_permission rules', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'npm test *',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
      },
    ]);

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'python3 /Users/example/runtime/scripts/dedup-append-lead.py',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          {
            toolName: 'Bash',
            ruleContent:
              '/Users/example/runtime/scripts/dedup-append-lead.py *',
          },
        ],
      },
    ]);
  });

  it('does not suggest persistent Bash wildcard rules', () => {
    for (const rule of ['*', '**', '* npm test']) {
      expect(
        requestPermissionReviewSuggestions({
          permissionKind: 'tool',
          toolName: 'Bash',
          rule,
          temporaryOnly: false,
        }),
      ).toBeUndefined();
    }
  });

  it('does not suggest persistent grants for invalid durable tool rules', () => {
    for (const toolName of [
      'mcp__github__*',
      'mcp__gantry__*',
      'Bash',
      'Bash(npm test)',
      'Bash(*)',
      'Bash(npm test',
      'tool:Browser',
      '*',
    ]) {
      expect(
        requestPermissionReviewSuggestions({
          permissionKind: 'tool',
          toolName,
          temporaryOnly: false,
        }),
      ).toBeUndefined();
    }
  });

  it('does not suggest persistent grants for broad exact SDK/native tools', () => {
    for (const toolName of ['Read', 'Write', 'Edit', 'WebFetch', 'LS']) {
      expect(
        requestPermissionReviewSuggestions({
          permissionKind: 'tool',
          toolName,
          temporaryOnly: false,
        }),
      ).toBeUndefined();
    }
  });

  it('does not suggest persistent grants for unknown semantic capabilities without a reviewed definition', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        capabilityId: 'acme.invoices.read',
        temporaryOnly: false,
      }),
    ).toBeUndefined();
  });

  it('does not suggest persistent Bash rules that contain secret-like material', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'curl https://example.com -H Authorization:Bearer abcdefghijklmnopqrstuvwxyz123456',
        temporaryOnly: false,
      }),
    ).toBeUndefined();
  });

  it('does not suggest persistent Bash rules with shell control or redirection syntax', () => {
    for (const rule of [
      'npm test * && npm run build',
      'npm test * > out',
      'cd /tmp/evil && npm test',
      '/bin/sh -c npm test',
      '/usr/bin/env npm test',
      'command sh -c npm test',
      'python3 *',
    ]) {
      expect(
        requestPermissionReviewSuggestions({
          permissionKind: 'tool',
          toolName: 'Bash',
          rule,
          temporaryOnly: false,
        }),
      ).toBeUndefined();
    }
  });

  it('formats public persistent-rule receipts without raw Bash command material', () => {
    const formatted = formatPersistentPermissionRulesForUser([
      'Bash(curl https://example.com -H Authorization:Bearer abcdefghijklmnopqrstuvwxyz123456)',
      'capability:google.sheets.write',
    ]);

    expect(formatted).toContain('scoped Bash rule [sha256:');
    expect(formatted).toContain('capability:google.sheets.write');
    expect(formatted).not.toContain('curl https://example.com');
    expect(formatted).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('rejects raw host-private browser persistent approval updates', async () => {
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
            rules: [{ toolName: 'mcp__browser' + '_' + 'backend' + '__click' }],
          },
        ],
      }),
    ).rejects.toThrow('Host-private browser backend tools');

    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it('rejects legacy exact Bash persistent approval updates', async () => {
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
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Bash' }],
          },
        ],
      }),
    ).rejects.toThrow('Persistent bare Bash grants are too broad');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects broad exact SDK/native persistent approval updates', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => [
        {
          id: 'tool:Read',
          appId: 'app:test',
          name: 'Read',
          status: 'active',
          selectable: true,
        },
      ]),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    for (const toolName of ['Read', 'Write', 'Edit', 'WebFetch', 'LS']) {
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
              rules: [{ toolName }],
            },
          ],
        }),
      ).rejects.toThrow('Provider-native SDK tools');
    }
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects exact third-party MCP persistent approval updates', async () => {
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
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'mcp__github__search_repositories' }],
          },
        ],
      }),
    ).rejects.toThrow('Persistent request_permission approvals support');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects secret-bearing persistent Bash approval updates', async () => {
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
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [
              {
                toolName: 'Bash',
                ruleContent:
                  'curl https://example.com -H Authorization:Bearer abcdefghijklmnopqrstuvwxyz123456',
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(
      'Persistent Bash rules cannot include secret-like material',
    );
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
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
            rules: [{ toolName: 'mcp__gantry__browser_act' }],
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

  it('writes approved persistent tools to the current run live permission file', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-live-tool-rules-'),
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

  it('persists multiple approved rules and mirrors them together', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-live-tool-rules-multi-'),
    );
    const repository = {
      getTool: vi.fn(async (toolId: string) =>
        toolId === 'tool:Browser'
          ? {
              id: 'tool:Browser',
              appId: 'app:test',
              status: 'active',
              selectable: true,
            }
          : null,
      ),
      listTools: vi.fn(async () => []),
      listAgentToolBindings: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    const persisted = await persistRequestPermissionRules({
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
          rules: [
            { toolName: 'Bash', ruleContent: 'npm test *' },
            { toolName: 'Browser' },
          ],
        },
      ],
    });

    expect(persisted).toEqual(['Bash(npm test *)', 'Browser']);
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['Bash(npm test *)', 'Browser'],
      { appId: 'app:test' },
    );
    expect(repository.saveAgentToolBinding).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(ipcDir, 'live-tool-rules', 'agent-run-1.json'),
          'utf-8',
        ),
      ),
    ).toEqual(['Bash(npm test *)', 'Browser']);
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

  it('rejects scoped non-Bash permission updates', async () => {
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
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Read', ruleContent: '**' }],
          },
        ],
      }),
    ).rejects.toThrow('Only Bash supports persistent scoped tool rules');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects persistent Bash wildcard approval updates', async () => {
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
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Bash', ruleContent: '*' }],
          },
        ],
      }),
    ).rejects.toThrow('Persistent Bash scope is too broad');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects persistent Bash approval updates with destructive redirects', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    for (const ruleContent of [
      'echo ok > /tmp/out',
      'echo ok >> /tmp/out',
      'echo ok 1> /tmp/out',
      'echo ok 2> /tmp/out',
    ]) {
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
              rules: [{ toolName: 'Bash', ruleContent }],
            },
          ],
        }),
      ).rejects.toThrow('destructive redirection');
    }
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rolls back active bindings when persistent settings mirror fails', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-live-tool-rules-rollback-'),
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

  it('rolls back active bindings when one rule write fails before settings mirror', async () => {
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-live-tool-rules-write-failure-'),
    );
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      listAgentToolBindings: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('binding write failed')),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

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
            rules: [
              { toolName: 'Bash', ruleContent: 'npm test *' },
              { toolName: 'Bash', ruleContent: 'git status' },
            ],
          },
        ],
      }),
    ).rejects.toThrow('binding write failed');
    expect(repository.saveAgentToolBinding).toHaveBeenCalledTimes(2);
    expect(repository.disableAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:test',
        toolId: expect.stringMatching(/^tool:permission-rule:/),
      }),
    );
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
    expect(
      fs.existsSync(path.join(ipcDir, 'live-tool-rules', 'agent-run-1.json')),
    ).toBe(false);
  });

  it('rejects persistent Gantry MCP wildcard approvals', async () => {
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
            rules: [{ toolName: 'mcp__gantry__*' }],
          },
        ],
      }),
    ).rejects.toThrow('wildcard grants are not supported');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects third-party MCP wildcard approvals', async () => {
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
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'mcp__github__*' }],
          },
        ],
      }),
    ).rejects.toThrow('request the MCP server capability');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects Gantry MCP wildcard approvals even when SDK sends rule content', async () => {
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
                toolName: 'mcp__gantry__*',
                ruleContent: 'service_restart',
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('wildcard grants are not supported');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects scoped admin MCP tool approvals', async () => {
    const repository = {
      getTool: vi.fn(async () => ({
        id: 'tool:mcp__gantry__service_restart',
        appId: 'app:test',
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
            rules: [
              {
                toolName: 'mcp__gantry__service_restart',
                ruleContent: 'reason=test',
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow('Only Bash supports persistent scoped tool rules');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });
});
