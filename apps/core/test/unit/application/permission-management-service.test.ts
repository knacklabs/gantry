import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PermissionManagementService } from '@core/application/permissions/permission-management-service.js';
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
        kind: 'mcp_tool',
        mcpTool: `mcp__caw-ats__${toolName}`,
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

describe('PermissionManagementService', () => {
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
        updatedAt: '2026-05-15T12:00:00.000Z',
      }),
    );
    expect(saveAgentBinding.mock.invocationCallOrder[0]).toBeLessThan(
      mirrorAgentToolRulesToSettings.mock.invocationCallOrder[0],
    );
  });

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
