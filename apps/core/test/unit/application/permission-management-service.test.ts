import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PermissionManagementService } from '@core/application/permissions/permission-management-service.js';
import { mcpServerDefinitionFingerprint } from '@core/application/mcp/mcp-server-definition-fingerprint.js';
import { withMcpCapabilityProposalSourceLocks } from '@core/application/permissions/mcp-capability-source-bindings.js';
import type {
  McpServerRepository,
  PermissionRepository,
} from '@core/domain/ports/repositories.js';
import type { PermissionDecision } from '@core/domain/permissions/permissions.js';
import type {
  AgentToolBinding,
  ToolCatalogItem,
} from '@core/domain/tools/tools.js';
import { persistentPermissionToolId } from '@core/shared/agent-tool-references.js';
import {
  adminMcpToolIdForFullName,
  isDurableGantryMcpToolFullName,
} from '@core/shared/admin-mcp-tools.js';
import {
  appendLiveToolRules,
  readLiveToolRules,
} from '@core/shared/live-tool-rules.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
} from '@core/shared/semantic-capabilities.js';

function permissionRepository(): {
  repository: PermissionRepository;
  saveDecision: ReturnType<typeof vi.fn>;
} {
  const saveDecision = vi.fn();
  return {
    saveDecision,
    repository: {
      savePolicy: vi.fn(),
      saveRule: vi.fn(),
      saveDecision,
      getDecision: vi.fn(),
    },
  };
}

function toolItem(name: string): ToolCatalogItem {
  return {
    id: persistentPermissionToolId('app:test', name) as never,
    appId: 'app:test' as never,
    name,
    kind: 'host',
    provider: 'gantry',
    displayName: name,
    category: 'files',
    risk: 'medium',
    selectable: true,
    status: 'active',
    adapterRef: 'permission/request_permission',
    createdAt: '2026-05-15T12:00:00.000Z' as never,
    updatedAt: '2026-05-15T12:00:00.000Z' as never,
  };
}

function semanticCapabilityToolItem(
  capability: SemanticCapabilityDefinition,
): ToolCatalogItem {
  return {
    id: `tool:capability:${capability.capabilityId}` as never,
    appId: 'app:test' as never,
    name: `capability:${capability.capabilityId}`,
    kind: capability.credentialSource === 'local_cli' ? 'local_cli' : 'host',
    provider:
      capability.credentialSource === 'local_cli' ? 'local_cli' : 'gantry',
    displayName: capability.displayName,
    category: 'productivity',
    risk: capability.risk === 'read' ? 'low' : 'high',
    selectable: true,
    status: 'active',
    adapterRef: `capability/${capability.capabilityId}`,
    inputSchema: semanticCapabilityInputSchema(capability),
    createdAt: '2026-05-15T12:00:00.000Z' as never,
    updatedAt: '2026-05-15T12:00:00.000Z' as never,
  };
}

function activeBinding(tool: ToolCatalogItem): AgentToolBinding {
  return {
    id: `binding:${tool.id}` as never,
    appId: 'app:test' as never,
    agentId: 'agent:test' as never,
    toolId: tool.id,
    status: 'active',
    createdAt: '2026-05-15T12:00:00.000Z' as never,
    updatedAt: '2026-05-15T12:00:00.000Z' as never,
  };
}

function skillActionCapability(): SemanticCapabilityDefinition {
  return {
    capabilityId: 'skill.linkedin-posting.publish',
    displayName: 'LinkedIn posting',
    category: 'LinkedIn posting',
    risk: 'write',
    can: 'Publish posts through the selected LinkedIn posting skill.',
    cannot: 'Use unrelated skills, credentials, settings, or broader commands.',
    credentialSource: 'skill_secret',
    implementationBindings: [
      {
        kind: 'tool_rule',
        rule: 'RunCommand(skills/linkedin-posting/post.py *)',
      },
    ],
    preflight: { kind: 'none' },
    source: {
      kind: 'skill_action',
      skillId: 'skill:linkedin-posting',
      skillName: 'linkedin-posting',
      actionId: 'publish',
    },
  };
}

function mcpCapability(
  toolName = 'ats_list_positions',
): SemanticCapabilityDefinition {
  return {
    capabilityId: 'mcp.caw-ats.access',
    version: '1',
    displayName: 'caw-ats MCP access',
    category: 'MCP',
    risk: 'write',
    can: 'Call approved caw-ats MCP tools.',
    cannot: 'Call unapproved MCP tools or receive raw credentials.',
    credentialSource: 'none',
    implementationBindings: [
      {
        kind: 'mcp_pattern',
        mcpServer: 'caw-ats',
        mcpToolPatterns: [toolName],
      },
    ],
    preflight: { kind: 'none' },
    source: {
      source: 'mcp',
      serverName: 'caw-ats',
      allowedToolPatterns: [toolName],
    },
  };
}

function proposedMcpCapability(
  toolName = 'ats_list_positions',
  server = proposalServer(),
): SemanticCapabilityDefinition {
  return {
    ...mcpCapability(toolName),
    source: {
      kind: 'mcp_capability_proposal',
      serverId: 'mcp:caw-ats',
      serverName: 'caw-ats',
      serverDefinitionFingerprint: mcpServerDefinitionFingerprint(
        server as never,
      ),
    },
  };
}

function proposalServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mcp:caw-ats',
    appId: 'app:test',
    name: 'caw-ats',
    status: 'active',
    createdSource: 'admin',
    riskClass: 'low',
    transport: 'http',
    config: { transport: 'http', url: 'http://127.0.0.1:3000/mcp' },
    allowedToolPatterns: ['ats_list_positions', 'ats_read_candidate'],
    autoApproveToolPatterns: [],
    credentialRefs: [],
    networkHosts: [],
    createdAt: '2026-05-15T11:00:00.000Z',
    updatedAt: '2026-05-15T11:00:00.000Z',
    ...overrides,
  };
}

describe('PermissionManagementService', () => {
  it('locks every proposed MCP source in one approval transaction', async () => {
    const first = proposedMcpCapability();
    const second: SemanticCapabilityDefinition = {
      ...first,
      capabilityId: 'mcp.docs.read',
      implementationBindings: [
        {
          kind: 'mcp_pattern',
          mcpServer: 'docs',
          mcpToolPatterns: ['docs_read'],
        },
      ],
      source: {
        kind: 'mcp_capability_proposal',
        serverId: 'mcp:docs',
        serverName: 'docs',
        serverDefinitionFingerprint: 'docs-fingerprint',
      },
    };
    const withMcpCapabilityApprovalLock = vi.fn(
      async ({ operation }: { operation: () => Promise<string> }) =>
        operation(),
    );

    await expect(
      withMcpCapabilityProposalSourceLocks({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        rules: [
          `capability:${first.capabilityId}`,
          `capability:${second.capabilityId}`,
        ],
        semanticCapabilityDefinitions: {
          [first.capabilityId]: first,
          [second.capabilityId]: second,
        },
        mcpServerRepository: {
          withMcpCapabilityApprovalLock,
        } as never,
        operation: async () => 'approved',
      }),
    ).resolves.toBe('approved');
    expect(withMcpCapabilityApprovalLock).toHaveBeenCalledWith({
      appId: 'app:test',
      serverNames: ['caw-ats', 'docs'],
      operation: expect.any(Function),
    });
  });

  it('records skill action source and command hash in permission audit context', async () => {
    const { repository, saveDecision } = permissionRepository();
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);
    const capability = skillActionCapability();

    await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      requestId: 'permission_skill_action',
      jobId: 'job:linkedin' as never,
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
        },
      ],
      toolRepository: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => [semanticCapabilityToolItem(capability)]),
        saveTool,
        saveAgentToolBinding: vi.fn(async () => undefined),
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      permissionRepository: repository,
    });

    expect(saveTool).not.toHaveBeenCalled();
    const decision = saveDecision.mock.calls[0]?.[0] as PermissionDecision;
    expect(decision.actorContext).toMatchObject({
      requestId: 'permission_skill_action',
      agentId: 'agent:test',
      jobId: 'job:linkedin',
      capabilitySource: 'skill_action',
      skillActions: [
        expect.objectContaining({
          capabilityId: 'skill.linkedin-posting.publish',
          displayName: 'LinkedIn posting',
          skillId: 'skill:linkedin-posting',
          skillName: 'linkedin-posting',
          actionId: 'publish',
          commandPreviewHashes: [expect.stringMatching(/^sha256:/)],
        }),
      ],
    });
    expect(
      (
        decision.actorContext?.skillActions as Array<{
          commandPreviewHashes: string[];
        }>
      )[0]?.commandPreviewHashes[0],
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('activates reviewed MCP sources before mirroring persistent MCP capability settings', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);
    const saveAgentBinding = vi.fn(async () => undefined);
    const appendAuditEvent = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const server = {
      id: 'mcp:caw-ats',
      appId: 'app:test',
      name: 'caw-ats',
      status: 'active',
      allowedToolPatterns: ['ats_list_positions'],
    };
    const mcpServerRepository = {
      getServerByName: vi.fn(async () => server),
      listAgentBindings: vi.fn(async () => [
        {
          id: 'agent-mcp-binding:agent:test:mcp:caw-ats',
          appId: 'app:test',
          agentId: 'agent:test',
          serverId: 'mcp:caw-ats',
          status: 'disabled',
          required: false,
          permissionPolicyIds: [],
          createdAt: '2026-05-15T11:00:00.000Z',
          updatedAt: '2026-05-15T11:00:00.000Z',
        },
      ]),
      saveAgentBinding,
      appendAuditEvent,
    } as unknown as McpServerRepository;

    const persisted = await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      requestId: 'permission_mcp',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
        },
      ],
      toolRepository: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => []),
        saveTool,
        saveAgentToolBinding: vi.fn(async () => undefined),
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mcpServerRepository,
      mirrorAgentToolRulesToSettings,
      semanticCapabilityDefinitions: {
        'mcp.caw-ats.access': mcpCapability(),
      },
    });

    expect(persisted).toEqual(['capability:mcp.caw-ats.access']);
    expect(saveAgentBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'mcp:caw-ats',
        status: 'active',
        createdAt: '2026-05-15T11:00:00.000Z',
      }),
    );
    expect(appendAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'bind',
        reason: 'Activated by persistent MCP capability approval.',
      }),
    );
    expect(saveAgentBinding.mock.invocationCallOrder[0]).toBeLessThan(
      mirrorAgentToolRulesToSettings.mock.invocationCallOrder[0],
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['capability:mcp.caw-ats.access'],
      { appId: 'app:test' },
    );
  });

  it('widens active MCP source scopes before mirroring additional persistent MCP capabilities', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveAgentBinding = vi.fn(async () => undefined);
    const appendAuditEvent = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const server = {
      id: 'mcp:caw-ats',
      appId: 'app:test',
      name: 'caw-ats',
      status: 'active',
      allowedToolPatterns: ['ats_list_positions', 'ats_read_candidate'],
    };
    const mcpServerRepository = {
      getServerByName: vi.fn(async () => server),
      listAgentBindings: vi.fn(async () => [
        {
          id: 'agent-mcp-binding:agent:test:mcp:caw-ats',
          appId: 'app:test',
          agentId: 'agent:test',
          serverId: 'mcp:caw-ats',
          status: 'active',
          required: false,
          permissionPolicyIds: [],
          allowedToolPatterns: ['ats_read_candidate'],
          conversationId: 'conversation:review',
          threadId: 'thread:review:topic',
          createdAt: '2026-05-15T11:00:00.000Z',
          updatedAt: '2026-05-15T11:00:00.000Z',
        },
      ]),
      saveAgentBinding,
      appendAuditEvent,
    } as unknown as McpServerRepository;

    await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      requestId: 'permission_mcp',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
        },
      ],
      toolRepository: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => []),
        saveTool: vi.fn(async () => undefined),
        saveAgentToolBinding: vi.fn(async () => undefined),
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mcpServerRepository,
      mirrorAgentToolRulesToSettings,
      semanticCapabilityDefinitions: {
        'mcp.caw-ats.access': mcpCapability('ats_list_positions'),
      },
    });

    expect(saveAgentBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        allowedToolPatterns: ['ats_read_candidate', 'ats_list_positions'],
        conversationId: 'conversation:review',
        threadId: 'thread:review:topic',
        updatedAt: '2026-05-15T12:00:00.000Z',
      }),
    );
    expect(saveAgentBinding.mock.invocationCallOrder[0]).toBeLessThan(
      mirrorAgentToolRulesToSettings.mock.invocationCallOrder[0],
    );
  });

  it('rejects a proposed MCP grant when source validation locking is unavailable', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);
    const saveAgentToolBinding = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    await expect(
      service.applyPersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
          },
        ],
        toolRepository: {
          getTool: vi.fn(async () => null),
          listTools: vi.fn(async () => []),
          saveTool,
          saveAgentToolBinding,
          disableAgentToolBinding: vi.fn(async () => null),
          listAgentToolBindings: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mirrorAgentToolRulesToSettings,
        semanticCapabilityDefinitions: {
          'mcp.caw-ats.access': proposedMcpCapability(),
        },
      }),
    ).rejects.toThrow('approval locking is required');

    expect(saveTool).not.toHaveBeenCalled();
    expect(saveAgentToolBinding).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'revoked',
      serverId: 'mcp:caw-ats',
      status: 'disabled',
      allowedToolPatterns: ['ats_list_positions'],
      error: 'is no longer active for this agent',
    },
    {
      name: 'narrowed',
      serverId: 'mcp:caw-ats',
      status: 'active',
      allowedToolPatterns: ['ats_read_candidate'],
      error: 'ats_list_positions is not within the reviewed tools for caw-ats',
    },
    {
      name: 'replaced',
      serverId: 'mcp:caw-ats-replacement',
      status: 'active',
      allowedToolPatterns: ['ats_list_positions'],
      error: 'no longer matches the server reviewed in this capability request',
    },
    {
      name: 'reconnected under the same id',
      serverId: 'mcp:caw-ats',
      serverConfigUrl: 'http://127.0.0.1:4000/mcp',
      status: 'active',
      allowedToolPatterns: ['ats_list_positions'],
      error: 'definition changed after this capability request was reviewed',
    },
  ])(
    'rejects a stale proposed MCP grant after its source is $name',
    async ({
      serverId,
      serverConfigUrl,
      status,
      allowedToolPatterns,
      error,
    }) => {
      const service = new PermissionManagementService({
        now: () => '2026-05-15T12:00:00.000Z',
      });
      const saveTool = vi.fn(async () => undefined);
      const saveAgentToolBinding = vi.fn(async () => undefined);
      const saveAgentBinding = vi.fn(async () => undefined);
      const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

      await expect(
        service.applyPersistentToolRuleGrant({
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
          sourceAgentFolder: 'main_agent',
          updates: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
            },
          ],
          toolRepository: {
            getTool: vi.fn(async () => null),
            listTools: vi.fn(async () => []),
            saveTool,
            saveAgentToolBinding,
            disableAgentToolBinding: vi.fn(async () => null),
            listAgentToolBindings: vi.fn(async () => []),
            listAgentToolBindingsForAgents: vi.fn(),
          },
          mcpServerRepository: {
            withMcpCapabilityApprovalLock: async ({ operation }) => operation(),
            getServerByName: vi.fn(async () =>
              proposalServer({
                id: serverId,
                ...(serverConfigUrl
                  ? {
                      config: { transport: 'http', url: serverConfigUrl },
                    }
                  : {}),
              }),
            ),
            listAgentBindings: vi.fn(async () => [
              {
                id: 'agent-mcp-binding:agent:test:mcp:caw-ats',
                appId: 'app:test',
                agentId: 'agent:test',
                serverId,
                status,
                required: false,
                permissionPolicyIds: [],
                allowedToolPatterns,
                createdAt: '2026-05-15T11:00:00.000Z',
                updatedAt: '2026-05-15T11:00:00.000Z',
              },
            ]),
            saveAgentBinding,
          } as never,
          mirrorAgentToolRulesToSettings,
          semanticCapabilityDefinitions: {
            'mcp.caw-ats.access': proposedMcpCapability(),
          },
        }),
      ).rejects.toThrow(error);

      expect(saveTool).not.toHaveBeenCalled();
      expect(saveAgentToolBinding).not.toHaveBeenCalled();
      expect(saveAgentBinding).not.toHaveBeenCalled();
      expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
    },
  );

  it('reactivates disabled MCP source bindings with only the newly approved scope', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveAgentBinding = vi.fn(async () => undefined);
    const server = {
      id: 'mcp:caw-ats',
      appId: 'app:test',
      name: 'caw-ats',
      status: 'active',
      allowedToolPatterns: ['ats_list_positions', 'ats_read_candidate'],
    };
    const mcpServerRepository = {
      getServerByName: vi.fn(async () => server),
      listAgentBindings: vi.fn(async () => [
        {
          id: 'agent-mcp-binding:agent:test:mcp:caw-ats',
          appId: 'app:test',
          agentId: 'agent:test',
          serverId: 'mcp:caw-ats',
          status: 'disabled',
          required: false,
          permissionPolicyIds: [],
          allowedToolPatterns: [],
          createdAt: '2026-05-15T11:00:00.000Z',
          updatedAt: '2026-05-15T11:00:00.000Z',
        },
      ]),
      saveAgentBinding,
      appendAuditEvent: vi.fn(async () => undefined),
    } as unknown as McpServerRepository;

    await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      requestId: 'permission_mcp',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
        },
      ],
      toolRepository: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => []),
        saveTool: vi.fn(async () => undefined),
        saveAgentToolBinding: vi.fn(async () => undefined),
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mcpServerRepository,
      mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      semanticCapabilityDefinitions: {
        'mcp.caw-ats.access': mcpCapability('ats_list_positions'),
      },
    });

    expect(saveAgentBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        allowedToolPatterns: ['ats_list_positions'],
      }),
    );
  });

  it('rolls back MCP source bindings when audit persistence fails', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveAgentBinding = vi.fn(async () => undefined);
    const disableAgentBinding = vi.fn(async () => null);
    const mcpServerRepository = {
      getServerByName: vi.fn(async () => ({
        id: 'mcp:caw-ats',
        appId: 'app:test',
        name: 'caw-ats',
        status: 'active',
        allowedToolPatterns: ['ats_list_positions'],
      })),
      listAgentBindings: vi.fn(async () => []),
      saveAgentBinding,
      disableAgentBinding,
      appendAuditEvent: vi.fn(async () => {
        throw new Error('audit failed');
      }),
    } as unknown as McpServerRepository;

    await expect(
      service.applyPersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        requestId: 'permission_mcp',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
          },
        ],
        toolRepository: {
          getTool: vi.fn(async () => null),
          listTools: vi.fn(async () => []),
          saveTool: vi.fn(async () => undefined),
          saveAgentToolBinding: vi.fn(async () => undefined),
          disableAgentToolBinding: vi.fn(async () => null),
          listAgentToolBindings: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mcpServerRepository,
        mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
        semanticCapabilityDefinitions: {
          'mcp.caw-ats.access': mcpCapability('ats_list_positions'),
        },
      }),
    ).rejects.toThrow('audit failed');

    expect(saveAgentBinding).toHaveBeenCalledTimes(1);
    expect(disableAgentBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'app:test',
        agentId: 'agent:test',
        serverId: 'mcp:caw-ats',
      }),
    );
  });

  it('restores previous MCP source bindings when persistent MCP settings mirroring fails', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const previousBinding = {
      id: 'agent-mcp-binding:agent:test:mcp:caw-ats',
      appId: 'app:test',
      agentId: 'agent:test',
      serverId: 'mcp:caw-ats',
      status: 'active' as const,
      required: false,
      permissionPolicyIds: [],
      allowedToolPatterns: ['ats_read_candidate'],
      createdAt: '2026-05-15T11:00:00.000Z',
      updatedAt: '2026-05-15T11:00:00.000Z',
    };
    const saveAgentBinding = vi.fn(async () => undefined);
    const disableAgentBinding = vi.fn(async () => null);
    const server = {
      id: 'mcp:caw-ats',
      appId: 'app:test',
      name: 'caw-ats',
      status: 'active',
      allowedToolPatterns: ['ats_list_positions', 'ats_read_candidate'],
    };
    const mcpServerRepository = {
      getServerByName: vi.fn(async () => server),
      listAgentBindings: vi.fn(async () => [previousBinding]),
      saveAgentBinding,
      disableAgentBinding,
      appendAuditEvent: vi.fn(async () => undefined),
    } as unknown as McpServerRepository;

    await expect(
      service.applyPersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        requestId: 'permission_mcp',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
          },
        ],
        toolRepository: {
          getTool: vi.fn(async () => null),
          listTools: vi.fn(async () => []),
          saveTool: vi.fn(async () => undefined),
          saveAgentToolBinding: vi.fn(async () => undefined),
          disableAgentToolBinding: vi.fn(async () => null),
          listAgentToolBindings: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mcpServerRepository,
        mirrorAgentToolRulesToSettings: vi.fn(async () => {
          throw new Error('settings mirror failed');
        }),
        semanticCapabilityDefinitions: {
          'mcp.caw-ats.access': mcpCapability('ats_list_positions'),
        },
      }),
    ).rejects.toThrow('settings mirror failed');

    expect(saveAgentBinding).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        allowedToolPatterns: ['ats_read_candidate', 'ats_list_positions'],
      }),
    );
    expect(saveAgentBinding).toHaveBeenNthCalledWith(2, previousBinding);
    expect(disableAgentBinding).not.toHaveBeenCalled();
  });

  it('canonicalizes generated skill runtime RunCommand grants to trusted skill action capabilities', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const capability = skillActionCapability();

    const persisted = await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      requestId: 'permission_skill_action_generated_path',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            {
              toolName: 'RunCommand',
              ruleContent:
                '/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *',
            },
          ],
        },
      ],
      toolRepository: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => [semanticCapabilityToolItem(capability)]),
        saveTool,
        saveAgentToolBinding: vi.fn(async () => undefined),
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings,
    });

    expect(persisted).toEqual(['capability:skill.linkedin-posting.publish']);
    expect(saveTool).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['capability:skill.linkedin-posting.publish'],
      { appId: 'app:test' },
    );
  });

  it('rejects request-supplied capability definitions that conflict with the catalog', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const catalogCapability = skillActionCapability();
    const requestCapability: SemanticCapabilityDefinition = {
      ...catalogCapability,
      implementationBindings: [
        {
          kind: 'tool_rule',
          rule: 'RunCommand(skills/linkedin-posting/admin.py *)',
        },
      ],
    };
    const saveTool = vi.fn(async () => undefined);
    const saveAgentToolBinding = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    await expect(
      service.applyPersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        requestId: 'permission_skill_action_conflict',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'capability:skill.linkedin-posting.publish' }],
          },
        ],
        semanticCapabilityDefinitions: {
          'skill.linkedin-posting.publish': requestCapability,
        },
        toolRepository: {
          getTool: vi.fn(async () => null),
          listTools: vi.fn(async () => [
            semanticCapabilityToolItem(catalogCapability),
          ]),
          saveTool,
          saveAgentToolBinding,
          disableAgentToolBinding: vi.fn(async () => null),
          listAgentToolBindings: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mirrorAgentToolRulesToSettings,
      }),
    ).rejects.toThrow(
      'Semantic capability skill.linkedin-posting.publish does not match the active catalog definition.',
    );

    expect(saveTool).not.toHaveBeenCalled();
    expect(saveAgentToolBinding).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it('reuses a concurrently persisted MCP proposal when only its display name differs', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-07-21T12:00:00.000Z',
    });
    const requested = {
      ...proposedMcpCapability(),
      displayName: 'Requested ATS reads',
    };
    const existing = {
      ...requested,
      displayName: 'Existing ATS reads',
    };
    const saveTool = vi.fn(async () => undefined);
    let sourceLockHeld = false;
    const saveAgentToolBinding = vi.fn(async () => {
      expect(sourceLockHeld).toBe(true);
    });
    const mirrorAgentToolRulesToSettings = vi.fn(async () => {
      expect(sourceLockHeld).toBe(true);
    });
    const withMcpCapabilityApprovalLock = vi.fn(
      async ({ operation }: { operation: () => Promise<string[]> }) => {
        sourceLockHeld = true;
        try {
          return await operation();
        } finally {
          sourceLockHeld = false;
        }
      },
    );

    const persisted = await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      requestId: 'permission-request:mcp-caw-ats',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'capability:mcp.caw-ats.access' }],
        },
      ],
      semanticCapabilityDefinitions: {
        'mcp.caw-ats.access': requested,
      },
      toolRepository: {
        getTool: vi.fn(async () => semanticCapabilityToolItem(existing)),
        listTools: vi.fn(async () => [semanticCapabilityToolItem(existing)]),
        saveTool,
        saveAgentToolBinding,
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mcpServerRepository: {
        withMcpCapabilityApprovalLock,
        getServerByName: vi.fn(async () => proposalServer()),
        listAgentBindings: vi.fn(async () => [
          {
            id: 'agent-mcp-binding:agent:test:mcp:caw-ats',
            appId: 'app:test',
            agentId: 'agent:test',
            serverId: 'mcp:caw-ats',
            status: 'active',
            required: false,
            permissionPolicyIds: [],
            allowedToolPatterns: ['ats_list_positions'],
            createdAt: '2026-07-21T11:00:00.000Z',
            updatedAt: '2026-07-21T11:00:00.000Z',
          },
        ]),
      } as never,
      mirrorAgentToolRulesToSettings,
    });

    expect(persisted).toEqual(['capability:mcp.caw-ats.access']);
    expect(saveTool).not.toHaveBeenCalled();
    expect(saveAgentToolBinding).toHaveBeenCalledTimes(1);
    expect(withMcpCapabilityApprovalLock).toHaveBeenCalledTimes(1);
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['capability:mcp.caw-ats.access'],
      {
        appId: 'app:test',
        expectedMcpBindings: [
          expect.objectContaining({
            serverId: 'mcp:caw-ats',
            status: 'active',
            allowedToolPatterns: ['ats_list_positions'],
          }),
        ],
        mcpCapabilityGrantToken: 'permission-request:mcp-caw-ats',
      },
    );
  });

  it('drops generated skill runtime RunCommand grants when no trusted skill action matches', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);
    const saveAgentToolBinding = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    const persisted = await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [
            {
              toolName: 'RunCommand',
              ruleContent:
                '/tmp/run/.llm-runtime/claude/skills/linkedin-posting/post.py *',
            },
          ],
        },
      ],
      toolRepository: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => []),
        saveTool,
        saveAgentToolBinding,
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings,
    });

    expect(persisted).toEqual([]);
    expect(saveTool).not.toHaveBeenCalled();
    expect(saveAgentToolBinding).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).not.toHaveBeenCalled();
  });

  it('creates a catalog row when a human grants a newly durable Gantry tool', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);
    const saveAgentToolBinding = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    const persisted = await service.applyPersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      updates: [
        {
          type: 'addRules',
          behavior: 'allow',
          rules: [{ toolName: 'mcp__gantry__task_cancel' }],
        },
      ],
      toolRepository: {
        getTool: vi.fn(async () => null),
        listTools: vi.fn(async () => []),
        saveTool,
        saveAgentToolBinding,
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings,
    });

    expect(persisted).toEqual(['mcp__gantry__task_cancel']);
    expect(saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: persistentPermissionToolId('app:test', 'mcp__gantry__task_cancel'),
        name: 'mcp__gantry__task_cancel',
        displayName: 'Task Cancel',
        risk: 'high',
      }),
    );
    expect(saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: persistentPermissionToolId(
          'app:test',
          'mcp__gantry__task_cancel',
        ),
        status: 'active',
      }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['mcp__gantry__task_cancel'],
      { appId: 'app:test' },
    );
  });

  it('revokes a current-agent persistent tool grant and mirrors settings removal', async () => {
    const { repository, saveDecision } = permissionRepository();
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const tool = toolItem('FileRead');
    const binding = activeBinding(tool);
    const disableAgentToolBinding = vi.fn(async () => ({
      ...binding,
      status: 'disabled' as const,
    }));
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    const result = await service.revokePersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      toolName: 'FileRead',
      reason: 'No longer needed',
      toolRepository: {
        getTool: vi.fn(),
        listTools: vi.fn(async () => [tool]),
        saveTool: vi.fn(),
        saveAgentToolBinding: vi.fn(),
        disableAgentToolBinding,
        listAgentToolBindings: vi.fn(async () => [binding]),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings,
      permissionRepository: repository,
    });

    expect(result).toEqual({ revokedRule: 'FileRead', toolId: tool.id });
    expect(disableAgentToolBinding).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      toolId: tool.id,
      updatedAt: '2026-05-15T12:00:00.000Z',
    });
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['FileRead'],
      { appId: 'app:test', mode: 'remove' },
    );
    const decision = saveDecision.mock.calls[0]?.[0] as PermissionDecision;
    expect(decision.effect).toBe('deny');
    expect(decision.actionPreview).toContain('revoke FileRead');
  });

  it('revokes legacy fixed-ID grants for Gantry tools that are no longer grantable', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });

    for (const toolName of ['service_restart', 'admin_permission_revoke']) {
      const fullName = `mcp__gantry__${toolName}`;
      expect(isDurableGantryMcpToolFullName(fullName)).toBe(false);
      const tool: ToolCatalogItem = {
        ...toolItem(fullName),
        id: `tool:${fullName}` as never,
        name: fullName,
      };
      const binding = activeBinding(tool);
      const disableAgentToolBinding = vi.fn(async () => ({
        ...binding,
        status: 'disabled' as const,
      }));
      const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

      const result = await service.revokePersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        toolName: fullName,
        toolRepository: {
          getTool: vi.fn(async () => null),
          listTools: vi.fn(async () => []),
          saveTool: vi.fn(),
          saveAgentToolBinding: vi.fn(),
          disableAgentToolBinding,
          listAgentToolBindings: vi.fn(async () => [binding]),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mirrorAgentToolRulesToSettings,
      });

      expect(result).toEqual({
        revokedRule: fullName,
        toolId: `tool:${fullName}`,
      });
      expect(disableAgentToolBinding).toHaveBeenCalledWith({
        appId: 'app:test',
        agentId: 'agent:test',
        toolId: `tool:${fullName}`,
        updatedAt: '2026-05-15T12:00:00.000Z',
      });
      expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
        'main_agent',
        [fullName],
        { appId: 'app:test', mode: 'remove' },
      );
    }
  });

  it('revokes a seeded scheduler grant through its fixed catalog ID', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const rule = 'mcp__gantry__scheduler_run_now';
    const tool: ToolCatalogItem = {
      ...toolItem(rule),
      id: adminMcpToolIdForFullName(rule) as never,
      name: rule,
    };
    const binding = activeBinding(tool);
    const disableAgentToolBinding = vi.fn(async () => ({
      ...binding,
      status: 'disabled' as const,
    }));
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    const result = await service.revokePersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      toolName: rule,
      toolRepository: {
        getTool: vi.fn(async (toolId: string) =>
          toolId === tool.id ? tool : null,
        ),
        listTools: vi.fn(async () => [tool]),
        saveTool: vi.fn(),
        saveAgentToolBinding: vi.fn(),
        disableAgentToolBinding,
        listAgentToolBindings: vi.fn(async () => [binding]),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings,
    });

    expect(result).toEqual({
      revokedRule: rule,
      toolId: adminMcpToolIdForFullName(rule),
    });
    expect(disableAgentToolBinding).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      toolId: adminMcpToolIdForFullName(rule),
      updatedAt: '2026-05-15T12:00:00.000Z',
    });
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      [rule],
      { appId: 'app:test', mode: 'remove' },
    );
  });

  it('revokes an app-scoped grant for a newly durable Gantry tool', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const tool: ToolCatalogItem = {
      ...toolItem('mcp__gantry__scheduler_resume_job'),
      name: 'mcp__gantry__scheduler_resume_job',
    };
    const binding = activeBinding(tool);
    const disableAgentToolBinding = vi.fn(async () => ({
      ...binding,
      status: 'disabled' as const,
    }));
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

    const result = await service.revokePersistentToolRuleGrant({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      sourceAgentFolder: 'main_agent',
      toolName: 'mcp__gantry__scheduler_resume_job',
      toolRepository: {
        getTool: vi.fn(async (toolId: string) =>
          toolId ===
          persistentPermissionToolId(
            'app:test',
            'mcp__gantry__scheduler_resume_job',
          )
            ? tool
            : null,
        ),
        listTools: vi.fn(async () => [tool]),
        saveTool: vi.fn(),
        saveAgentToolBinding: vi.fn(),
        disableAgentToolBinding,
        listAgentToolBindings: vi.fn(async () => [binding]),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings,
    });

    expect(result).toEqual({
      revokedRule: 'mcp__gantry__scheduler_resume_job',
      toolId: persistentPermissionToolId(
        'app:test',
        'mcp__gantry__scheduler_resume_job',
      ),
    });
    expect(disableAgentToolBinding).toHaveBeenCalledWith({
      appId: 'app:test',
      agentId: 'agent:test',
      toolId: persistentPermissionToolId(
        'app:test',
        'mcp__gantry__scheduler_resume_job',
      ),
      updatedAt: '2026-05-15T12:00:00.000Z',
    });
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['mcp__gantry__scheduler_resume_job'],
      { appId: 'app:test', mode: 'remove' },
    );
  });

  it('removes expanded live rules when revoking a skill action grant', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const capability = skillActionCapability();
    const tool: ToolCatalogItem = {
      ...toolItem('capability:skill.linkedin-posting.publish'),
      id: 'tool:capability:skill.linkedin-posting.publish' as never,
      displayName: 'LinkedIn posting',
      inputSchema: semanticCapabilityInputSchema(capability),
    };
    const binding = activeBinding(tool);
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-skill-action-revoke-'),
    );
    try {
      appendLiveToolRules({
        ipcDir,
        runHandle: 'run_1',
        rules: [
          'capability:skill.linkedin-posting.publish',
          'RunCommand(skills/linkedin-posting/post.py *)',
        ],
      });

      await service.revokePersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        toolName: 'capability:skill.linkedin-posting.publish',
        reason: 'No longer needed',
        toolRepository: {
          getTool: vi.fn(),
          listTools: vi.fn(async () => [tool]),
          saveTool: vi.fn(),
          saveAgentToolBinding: vi.fn(),
          disableAgentToolBinding: vi.fn(async () => ({
            ...binding,
            status: 'disabled' as const,
          })),
          listAgentToolBindings: vi.fn(async () => [binding]),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
        ipcDir,
        runHandle: 'run_1',
      });

      expect(readLiveToolRules({ ipcDir, runHandle: 'run_1' })).toEqual([]);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('restores expanded live rules when revoking a skill action grant rolls back', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const capability = skillActionCapability();
    const tool: ToolCatalogItem = {
      ...toolItem('capability:skill.linkedin-posting.publish'),
      id: 'tool:capability:skill.linkedin-posting.publish' as never,
      displayName: 'LinkedIn posting',
      inputSchema: semanticCapabilityInputSchema(capability),
    };
    const binding = activeBinding(tool);
    const ipcDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gantry-skill-action-revoke-rollback-'),
    );
    try {
      await expect(
        service.revokePersistentToolRuleGrant({
          appId: 'app:test' as never,
          agentId: 'agent:test' as never,
          sourceAgentFolder: 'main_agent',
          toolName: 'capability:skill.linkedin-posting.publish',
          reason: 'No longer needed',
          toolRepository: {
            getTool: vi.fn(),
            listTools: vi.fn(async () => [tool]),
            saveTool: vi.fn(),
            saveAgentToolBinding: vi.fn(async () => undefined),
            disableAgentToolBinding: vi.fn(async () => ({
              ...binding,
              status: 'disabled' as const,
            })),
            listAgentToolBindings: vi.fn(async () => [binding]),
            listAgentToolBindingsForAgents: vi.fn(),
          },
          mirrorAgentToolRulesToSettings: vi.fn(async () => {
            throw new Error('settings mirror failed');
          }),
          ipcDir,
          runHandle: 'run_1',
        }),
      ).rejects.toThrow('settings mirror failed');

      expect(readLiveToolRules({ ipcDir, runHandle: 'run_1' })).toEqual([
        'capability:skill.linkedin-posting.publish',
        'RunCommand(skills/linkedin-posting/post.py *)',
      ]);
    } finally {
      fs.rmSync(ipcDir, { recursive: true, force: true });
    }
  });

  it('denies revoking grants that are not active for the current agent', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const tool = toolItem('FileRead');

    await expect(
      service.revokePersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        toolName: 'FileRead',
        toolRepository: {
          getTool: vi.fn(),
          listTools: vi.fn(async () => [tool]),
          saveTool: vi.fn(),
          saveAgentToolBinding: vi.fn(),
          disableAgentToolBinding: vi.fn(),
          listAgentToolBindings: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mirrorAgentToolRulesToSettings: vi.fn(),
      }),
    ).rejects.toThrow('No active current-agent tool grant matches FileRead');
  });

  it('rolls back disabled bindings when settings mirror removal fails', async () => {
    const { repository, saveDecision } = permissionRepository();
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const tool = toolItem('FileEdit');
    const binding = activeBinding(tool);
    const saveAgentToolBinding = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi
      .fn()
      .mockRejectedValueOnce(new Error('settings mirror failed'))
      .mockResolvedValueOnce(undefined);

    await expect(
      service.revokePersistentToolRuleGrant({
        appId: 'app:test' as never,
        agentId: 'agent:test' as never,
        sourceAgentFolder: 'main_agent',
        toolName: 'FileEdit',
        toolRepository: {
          getTool: vi.fn(),
          listTools: vi.fn(async () => [tool]),
          saveTool: vi.fn(),
          saveAgentToolBinding,
          disableAgentToolBinding: vi.fn(async () => ({
            ...binding,
            status: 'disabled' as const,
          })),
          listAgentToolBindings: vi.fn(async () => [binding]),
          listAgentToolBindingsForAgents: vi.fn(),
        },
        mirrorAgentToolRulesToSettings,
        permissionRepository: repository,
      }),
    ).rejects.toThrow('settings mirror failed');

    expect(saveAgentToolBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: tool.id,
        status: 'active',
      }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenNthCalledWith(
      2,
      'main_agent',
      ['FileEdit'],
      { appId: 'app:test' },
    );
    const decision = saveDecision.mock.calls[0]?.[0] as PermissionDecision;
    expect(decision.effect).toBe('deny');
    expect(decision.reason).toBe('settings mirror failed');
  });
});
