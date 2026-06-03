import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  formatDurableAccessRulesForUser,
  persistRequestPermissionRules,
  requestPermissionDescription,
  requestPermissionQueuedMessage,
  requestPermissionReviewSuggestions,
  requestPermissionSetupDecisionOptions,
  semanticCapabilityDefinitionsForToolInput,
} from '@core/jobs/request-permission-review.js';
import type { SemanticCapabilityDefinition } from '@core/shared/semantic-capabilities.js';

const acmeAppendCapability: SemanticCapabilityDefinition = {
  capabilityId: 'acme.records.append',
  displayName: 'Acme records append',
  category: 'Acme',
  risk: 'write',
  can: 'Append records through the reviewed CLI binding.',
  cannot: 'Read unrelated records or expose raw credentials.',
  credentialSource: 'local_cli',
  implementationBindings: [
    {
      kind: 'local_cli',
      executablePath: '/usr/local/bin/acme',
      executableVersion: '1.0.0',
      executableHash: 'sha256:abc123',
      commandTemplates: ['/usr/local/bin/acme records append *'],
    },
  ],
};

const acmeAdapterCapability: SemanticCapabilityDefinition = {
  capabilityId: 'acme.records.get',
  displayName: 'Acme records get',
  category: 'Acme',
  risk: 'read',
  can: 'Read records through the reviewed adapter binding.',
  cannot: 'Write records or expose raw credentials.',
  credentialSource: 'configured_access',
  implementationBindings: [
    {
      kind: 'adapter',
      adapterRef: 'adapter:acme.records.get',
    },
  ],
};

const skillPublishCapability: SemanticCapabilityDefinition = {
  capabilityId: 'skill.publisher.publish',
  displayName: 'Publisher publish',
  category: 'Publisher',
  risk: 'write',
  can: 'Publish prepared content through the selected skill.',
  cannot: 'Use unrelated skills or credentials.',
  credentialSource: 'skill_secret',
  implementationBindings: [
    {
      kind: 'tool_rule',
      rule: 'RunCommand(skills/publisher/publish.py *)',
    },
  ],
  preflight: { kind: 'none' },
  source: {
    kind: 'skill_action',
    skillId: 'skill:publisher',
    skillName: 'publisher',
    actionId: 'publish',
  },
};

function depsWith(repository: unknown) {
  return {
    getToolRepository: () => repository as never,
    mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
  };
}

describe('request permission review helpers', () => {
  it('keeps setup request_permission copy aligned with configured options', () => {
    expect(
      requestPermissionQueuedMessage({
        toolName: 'request_permission',
        displayName: 'permission: SandboxNetworkAccess',
      }),
    ).not.toContain('Always allow');
    expect(requestPermissionDescription()).not.toContain('Always allow');
  });

  it('does not suggest persistent tool grants for temporary, non-tool, or multi-tool requests', () => {
    expect(
      requestPermissionReviewSuggestions({
        temporaryOnly: true,
        toolName: 'Bash',
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'provider',
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

  it('omits timed grants from setup request permission choices', () => {
    expect(
      requestPermissionSetupDecisionOptions({
        permissionKind: 'tool',
        toolName: 'FileRead',
        temporaryOnly: false,
      }),
    ).toEqual(['allow_once', 'allow_persistent_rule', 'cancel']);

    expect(
      requestPermissionSetupDecisionOptions({
        permissionKind: 'tool',
        toolName: 'SandboxNetworkAccess',
        temporaryOnly: false,
      }),
    ).toEqual(['allow_once', 'cancel']);
  });

  it('suggests semantic capability grants by capability id', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        capabilityRequestSource: 'request_access',
        capabilityId: 'acme.records.append',
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:acme.records.append' }],
      },
    ]);
  });

  it('does not trust agent-authored semantic capability definitions', () => {
    expect(
      semanticCapabilityDefinitionsForToolInput({
        permissionKind: 'tool',
        capabilityRequestSource: 'request_access',
        capabilityId: 'acme.records.get',
        semanticCapabilityDefinition: acmeAdapterCapability,
      }),
    ).toBeUndefined();

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        capabilityRequestSource: 'request_access',
        capabilityId: 'acme.records.get',
        semanticCapabilityDefinition: acmeAdapterCapability,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:acme.records.get' }],
      },
    ]);
  });

  it('suggests exact Gantry facade grants for durable request_permission tool requests', () => {
    for (const toolName of ['WebRead', 'FileRead', 'FileEdit', 'FileWrite']) {
      expect(
        requestPermissionReviewSuggestions({
          permissionKind: 'tool',
          toolName,
          temporaryOnly: false,
        }),
      ).toEqual([
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName }],
        },
      ]);
    }
  });

  it('prefers explicit scoped RunCommand permission over capability metadata on setup requests', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolNames: ['Bash'],
        rule: '/usr/local/bin/acme records append *',
        capabilityId: 'acme.records.append',
        capabilityDisplayName: 'Acme records append using acme',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          {
            toolName: 'RunCommand',
            ruleContent: '/usr/local/bin/acme records append *',
          },
        ],
      },
    ]);
  });

  it('does not suggest durable host-owned Python script RunCommand rules', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'python3 /Users/example/scripts/dedup-append-lead.py *',
        temporaryOnly: false,
      }),
    ).toBeUndefined();

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'python3 /Users/example/scripts/dedup-append-lead.py',
        temporaryOnly: false,
      }),
    ).toBeUndefined();
  });

  it('does not register agent-authored local CLI capability definitions from request_permission', async () => {
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
      networkHosts: ['api.acme.test', 'oauth2.acme.test'],
    };

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        capabilityRequestSource: 'request_access',
        temporaryOnly: false,
        ...toolInput,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:acme.invoices.read' }],
      },
    ]);

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
    ).rejects.toThrow('Unknown semantic capability acme.invoices.read');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects agent-authored local CLI implementation for an existing semantic id', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      listAgentToolBindings: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };
    const toolInput = {
      capabilityId: 'acme.records.append',
      capabilityDisplayName: 'Acme records append using acme',
      category: 'Acme Records',
      risk: 'write',
      accountLabel: 'acme',
      can: 'Append rows using acme.',
      cannot: 'Use configured broker Google access.',
      credentialSource: 'local_cli',
      executablePath: '/usr/local/bin/acme',
      executableVersion: '1.2.3',
      executableHash: 'sha256:acme',
      commandTemplates: ['/usr/local/bin/acme records append *'],
    };

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        capabilityRequestSource: 'request_access',
        temporaryOnly: false,
        ...toolInput,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:acme.records.append' }],
      },
    ]);

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
            rules: [{ toolName: 'capability:acme.records.append' }],
          },
        ],
      }),
    ).rejects.toThrow('Unknown semantic capability acme.records.append');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('grants existing catalog semantic capabilities without trusting request payload definitions', async () => {
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

    await persistRequestPermissionRules({
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
    });
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'tool:capability:acme.invoices.read',
        status: 'active',
      }),
    );
  });

  it('stores scoped RunCommand permission rules as synthetic permission tools', async () => {
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

    expect(persisted).toEqual(['RunCommand(npm test *)']);
    expect(repository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^tool:permission-rule:/),
        name: 'RunCommand(npm test *)',
      }),
    );
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: expect.stringMatching(/^tool:permission-rule:/),
      }),
    );
  });

  it('records request_permission persistent grants at parent conversation scope', async () => {
    const saveDecision = vi.fn(async () => undefined);
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    await persistRequestPermissionRules({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      deps: {
        getToolRepository: () => repository as never,
        getPermissionRepository: () =>
          ({
            saveDecision,
          }) as never,
        mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      },
      sourceAgentFolder: 'main_agent',
      conversationId: 'tg:team',
      threadId: 'topic-7',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
        },
      ],
    });

    const savedDecision = saveDecision.mock.calls[0]?.[0];
    expect(savedDecision.actorContext).toMatchObject({
      conversationId: 'tg:team',
      mode: 'allow_persistent_rule',
    });
    expect(savedDecision.actorContext).not.toHaveProperty('threadId');
  });

  it('persists scoped RunCommand permission when SDK command content contains parentheses', async () => {
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

    const readableRule = `RunCommand(${ruleContent})`;
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

  it('suggests persistent scoped RunCommand request_permission rules', () => {
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
        rules: [{ toolName: 'RunCommand', ruleContent: 'npm test *' }],
      },
    ]);

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'python3 /Users/example/runtime/scripts/dedup-append-lead.py',
        temporaryOnly: false,
      }),
    ).toBeUndefined();
  });

  it('suggests persistent scoped RunCommand rules from setup recovery actions', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'RunCommand',
        rule: 'acme records append *',
        temporaryOnly: false,
      }),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [
          { toolName: 'RunCommand', ruleContent: 'acme records append *' },
        ],
      },
    ]);
  });

  it('does not suggest persistent RunCommand wildcard rules', () => {
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
      'RunCommand(npm test)',
      'RunCommand(*)',
      'RunCommand(npm test',
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
    for (const toolName of ['LS', 'NotebookEdit', 'ToolSearch', 'Skill']) {
      expect(
        requestPermissionReviewSuggestions({
          permissionKind: 'tool',
          toolName,
          temporaryOnly: false,
        }),
      ).toBeUndefined();
    }
  });

  it('only suggests semantic capability grants from the request_access path', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        capabilityId: 'acme.invoices.read',
        temporaryOnly: false,
      }),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions(
        {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityId: 'acme.invoices.read',
          temporaryOnly: false,
        },
        {
          semanticCapabilityDefinitions: {
            'acme.records.append': acmeAppendCapability,
          },
        },
      ),
    ).toBeUndefined();
    expect(
      requestPermissionReviewSuggestions(
        {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityId: 'acme.invoices.read',
          temporaryOnly: false,
        },
        {
          semanticCapabilityDefinitions: {
            'acme.invoices.read': {
              ...acmeAppendCapability,
              capabilityId: 'acme.invoices.read',
            },
          },
        },
      ),
    ).toEqual([
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'session',
        rules: [{ toolName: 'capability:acme.invoices.read' }],
      },
    ]);
  });

  it('persists host-supplied selected skill capability definitions', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      listAgentToolBindings: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    const persisted = await persistRequestPermissionRules({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      deps: depsWith(repository),
      sourceAgentFolder: 'main_agent',
      semanticCapabilityDefinitions: {
        'skill.publisher.publish': skillPublishCapability,
      },
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:skill.publisher.publish' }],
        },
      ],
    });

    expect(persisted).toEqual(['capability:skill.publisher.publish']);
    expect(repository.saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool:capability:skill.publisher.publish',
        name: 'capability:skill.publisher.publish',
      }),
    );
    expect(repository.saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: 'tool:capability:skill.publisher.publish',
      }),
    );
  });

  it('rejects unknown semantic capability persistent approval updates without trusted definitions', async () => {
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
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
    ).rejects.toThrow('Unknown semantic capability acme.invoices.read');
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects agent-authored skill action capability definitions in request_permission', async () => {
    const fakeSkillCapability = {
      capabilityId: 'skill.linkedin-posting.publish',
      capabilityDisplayName: 'LinkedIn posting',
      semanticCapabilityDefinition: {
        capabilityId: 'skill.linkedin-posting.publish',
        displayName: 'LinkedIn posting',
        category: 'linkedin-posting',
        risk: 'write',
        can: 'Publish posts through the selected LinkedIn posting skill.',
        cannot:
          'Use unrelated skills, credentials, settings, or broader commands.',
        credentialSource: 'skill_secret',
        implementationBindings: [
          {
            kind: 'tool_rule',
            rule: 'RunCommand(skills/linkedin-posting/post.py *)',
          },
        ],
        preflight: { kind: 'none' },
      },
      temporaryOnly: false,
    };
    const repository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      listAgentToolBindings: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
    };

    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        ...fakeSkillCapability,
      }),
    ).toBeUndefined();
    expect(
      requestPermissionSetupDecisionOptions({
        permissionKind: 'tool',
        ...fakeSkillCapability,
      }),
    ).toEqual(['allow_once', 'cancel']);

    await expect(
      persistRequestPermissionRules({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        deps: depsWith(repository),
        sourceAgentFolder: 'main_agent',
        toolInput: fakeSkillCapability,
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
          },
        ],
      }),
    ).rejects.toThrow(
      'Unknown semantic capability skill.linkedin-posting.publish',
    );
    expect(repository.saveTool).not.toHaveBeenCalled();
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('does not suggest persistent RunCommand rules that contain secret-like material', () => {
    expect(
      requestPermissionReviewSuggestions({
        permissionKind: 'tool',
        toolName: 'Bash',
        rule: 'curl https://example.com -H Authorization:Bearer abcdefghijklmnopqrstuvwxyz123456',
        temporaryOnly: false,
      }),
    ).toBeUndefined();
  });

  it('does not suggest persistent RunCommand rules with shell control or redirection syntax', () => {
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

  it('formats public persistent-rule receipts with redacted command scope', () => {
    const formatted = formatDurableAccessRulesForUser(
      [
        'RunCommand(curl https://example.com -H Authorization:Bearer abcdefghijklmnopqrstuvwxyz123456)',
        'capability:acme.records.append',
      ],
      {
        semanticCapabilityDefinitions: {
          'acme.records.append': acmeAppendCapability,
        },
      },
    );

    expect(formatted).toContain('matching command access');
    expect(formatted).toContain('Acme records append');
    expect(formatted).toContain('curl https://example.com');
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
    ).rejects.toThrow('Persistent bare RunCommand grants are too broad');
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

    for (const toolName of ['LS', 'NotebookEdit', 'ToolSearch', 'Skill']) {
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
    ).rejects.toThrow('Persistent access approvals support');
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
      'Persistent RunCommand rules cannot include secret-like material',
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

    expect(persisted).toEqual(['RunCommand(npm test *)']);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(ipcDir, 'live-tool-rules', 'agent-run-1.json'),
          'utf-8',
        ),
      ),
    ).toEqual(['RunCommand(npm test *)']);
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

    expect(persisted).toEqual(['RunCommand(npm test *)', 'Browser']);
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['RunCommand(npm test *)', 'Browser'],
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
    ).toEqual(['RunCommand(npm test *)', 'Browser']);
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

  it('rejects scoped non-RunCommand permission updates', async () => {
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
    ).rejects.toThrow('Only RunCommand supports persistent scoped tool rules');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects persistent RunCommand wildcard approval updates', async () => {
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
    ).rejects.toThrow('Persistent RunCommand scope is too broad');
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
    ).rejects.toThrow('request a reviewed semantic capability');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });

  it('rejects Gantry MCP wildcard approvals even when SDK sends rule content', async () => {
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
    ).rejects.toThrow('Only RunCommand supports persistent scoped tool rules');
    expect(repository.saveAgentToolBinding).not.toHaveBeenCalled();
  });
});
