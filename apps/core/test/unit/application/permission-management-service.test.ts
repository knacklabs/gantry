import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { PermissionManagementService } from '@core/application/permissions/permission-management-service.js';
import type { PermissionRepository } from '@core/domain/ports/repositories.js';
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

describe('PermissionManagementService', () => {
  it('records timed grant expiry for audit without requiring a new schema', async () => {
    const { repository, saveDecision } = permissionRepository();
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });

    await service.recordDecision({
      appId: 'app:test' as never,
      agentId: 'agent:test' as never,
      requestId: 'permission_123',
      toolName: 'Bash',
      conversationId: 'tg:123',
      decision: {
        approved: true,
        mode: 'allow_timed_grant',
        reason: 'timed grant for eligible tools and SDK API prompts',
        decisionClassification: 'user_temporary',
        timedGrantExpiresAtMs: Date.parse('2026-05-15T12:05:00.000Z'),
      },
      permissionRepository: repository,
    });

    const decision = saveDecision.mock.calls[0]?.[0] as PermissionDecision;
    expect(decision.expiresAt).toBe('2026-05-15T12:05:00.000Z');
    expect(decision.actorContext).toMatchObject({
      requestId: 'permission_123',
      agentId: 'agent:test',
      conversationId: 'tg:123',
      mode: 'allow_timed_grant',
      classification: 'user_temporary',
    });
  });

  it('records skill action source and command hash in permission audit context', async () => {
    const { repository, saveDecision } = permissionRepository();
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);

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
        listTools: vi.fn(async () => []),
        saveTool,
        saveAgentToolBinding: vi.fn(async () => undefined),
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings: vi.fn(async () => undefined),
      permissionRepository: repository,
      semanticCapabilityDefinitions: {
        'skill.linkedin-posting.publish': skillActionCapability(),
      },
    });

    expect(saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool:capability:skill.linkedin-posting.publish',
      }),
    );
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

  it('canonicalizes generated skill runtime RunCommand grants to trusted skill action capabilities', async () => {
    const service = new PermissionManagementService({
      now: () => '2026-05-15T12:00:00.000Z',
    });
    const saveTool = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);

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
        listTools: vi.fn(async () => []),
        saveTool,
        saveAgentToolBinding: vi.fn(async () => undefined),
        disableAgentToolBinding: vi.fn(async () => null),
        listAgentToolBindings: vi.fn(async () => []),
        listAgentToolBindingsForAgents: vi.fn(),
      },
      mirrorAgentToolRulesToSettings,
      semanticCapabilityDefinitions: {
        'skill.linkedin-posting.publish': skillActionCapability(),
      },
    });

    expect(persisted).toEqual(['capability:skill.linkedin-posting.publish']);
    expect(saveTool).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'tool:capability:skill.linkedin-posting.publish',
      }),
    );
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'main_agent',
      ['capability:skill.linkedin-posting.publish'],
      { appId: 'app:test' },
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
