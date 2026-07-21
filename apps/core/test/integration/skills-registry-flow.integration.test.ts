import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalSkillArtifactStore } from '@core/adapters/artifacts/skills/local-skill-artifact-store.js';
import { startTestControlServer } from '../harness/control-http-server.js';
import { makeSkillZip } from '../harness/test-skill-zip.js';
import {
  SkillCatalogItemResponseSchema,
  type SkillCatalogItemResponse,
} from '@gantry/contracts';
import { syncRuntimeSettingsFromProjection } from '@core/config/index.js';
import { semanticCapabilityInputSchema } from '@core/shared/semantic-capabilities.js';
import { createClient } from '../../../../packages/sdk/src/index.js';

type StoredSkill = SkillCatalogItemResponse;

const state = vi.hoisted(() => ({
  artifactRoot: '',
  skills: new Map<string, StoredSkill>(),
  bindings: new Map<string, any>(),
  secrets: new Map<string, any>(),
}));

vi.mock('@core/config/index.js', () => ({
  AGENT_MAX_OUTPUT_SIZE: 200_000,
  GANTRY_HOME: '/tmp/gantry-skills-integration-home',
  GANTRY_IPC_AUTH_SECRET: 'test-ipc-secret',
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  getDeploymentMode: vi.fn(() => 'workstation'),
  syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
  getRuntimeModelDefaults: vi.fn(() => ({ defaults: {} })),
  getRuntimeSettingsForConfig: vi.fn(() => ({
    agents: {
      'agent:one': { accessPreset: 'full' },
      'agent:other': { accessPreset: 'full' },
    },
  })),
  patchRuntimeModelDefaults: vi.fn(() => ({ ok: true })),
  configureDesiredSettingsStorageProvider: vi.fn(() => undefined),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isJobTriggerQueueReady: vi.fn(() => true),
  isSchedulerReady: vi.fn(() => true),
  runtimeJobSchedulePlanner: {
    createManualJobId: () => 'job-test',
    createJobId: () => 'job-test',
    planAppSchedule: () => ({
      scheduleType: 'manual',
      scheduleValue: 'manual',
      nextRun: null,
    }),
    planInitial: () => ({ nextRun: '2026-04-24T01:00:00.000Z' }),
    planResume: ({ job, clock }) =>
      job.next_run ??
      (job.schedule_type === 'manual'
        ? null
        : job.schedule_type === 'once'
          ? job.schedule_value
          : clock.now()),
  },
  requestSchedulerSync: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', async () => {
  const { LocalSkillArtifactStore } = await vi.importActual<
    typeof import('@core/adapters/artifacts/skills/local-skill-artifact-store.js')
  >('@core/adapters/artifacts/skills/local-skill-artifact-store.js');
  const skillsRepo = {
    getSkill: vi.fn(async (id: string) => state.skills.get(id) ?? null),
    listSkills: vi.fn(async (input: any) =>
      [...state.skills.values()]
        .filter(
          (skill) =>
            skill.appId === input.appId &&
            (!input.agentId || skill.agentId === input.agentId) &&
            (!input.statuses || input.statuses.includes(skill.status)),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    ),
    saveSkill: vi.fn(async (skill: StoredSkill) => {
      state.skills.set(skill.id, skill);
    }),
    saveAgentSkillBinding: vi.fn(async (binding: any) => {
      state.bindings.set(
        `${binding.appId}:${binding.agentId}:${binding.skillId}`,
        binding,
      );
    }),
    disableAgentSkillBinding: vi.fn(async (input: any) => {
      const key = `${input.appId}:${input.agentId}:${input.skillId}`;
      const existing = state.bindings.get(key);
      if (!existing) return null;
      const disabled = { ...existing, status: 'disabled' };
      state.bindings.set(key, disabled);
      return disabled;
    }),
    listAgentSkillBindings: vi.fn(async (input: any) =>
      [...state.bindings.values()].filter(
        (binding) =>
          binding.appId === input.appId && binding.agentId === input.agentId,
      ),
    ),
    listAgentSkillBindingsForAgents: vi.fn(async (input: any) =>
      [...state.bindings.values()].filter(
        (binding) =>
          binding.appId === input.appId &&
          input.agentIds.includes(binding.agentId),
      ),
    ),
    listEnabledSkillsForAgent: vi.fn(async (input: any) =>
      [...state.bindings.values()]
        .filter(
          (binding) =>
            binding.appId === input.appId &&
            binding.agentId === input.agentId &&
            binding.status === 'active',
        )
        .map((binding) => state.skills.get(binding.skillId))
        .filter(
          (skill): skill is StoredSkill =>
            Boolean(skill) && skill.status === 'installed',
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  };
  const capabilitySecretsRepo = {
    getSecret: vi.fn(
      async (input: { appId: string; name: string }) =>
        state.secrets.get(`${input.appId}:${input.name}`) ?? null,
    ),
    listSecrets: vi.fn(async (input: { appId: string }) =>
      [...state.secrets.values()]
        .filter((secret) => secret.appId === input.appId)
        .map(({ value: _value, ...metadata }) => metadata),
    ),
    upsertSecret: vi.fn(async (input: any) => {
      const now = input.now ?? new Date(0).toISOString();
      const record = {
        id: `secret:${input.appId}:${input.name}`,
        appId: input.appId,
        name: input.name,
        value: input.value,
        allowedCapabilityIds: input.allowedCapabilityIds ?? [],
        createdAt: now,
        updatedAt: now,
      };
      state.secrets.set(`${input.appId}:${input.name}`, record);
      const { value: _value, ...metadata } = record;
      return metadata;
    }),
    deleteSecret: vi.fn(async (input: { appId: string; name: string }) =>
      state.secrets.delete(`${input.appId}:${input.name}`),
    ),
  };
  const agentsRepo = {
    listAgents: vi.fn(async (appId: string) => [
      {
        id: 'agent:one',
        appId,
        name: 'Agent One',
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
    ]),
    getAgent: vi.fn(async (agentId: string) => {
      if (agentId === 'agent:one') {
        return {
          id: agentId,
          appId: 'app-one',
          name: 'Agent One',
          status: 'active',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
      }
      if (agentId === 'agent:other') {
        return {
          id: agentId,
          appId: 'app-two',
          name: 'Other Agent',
          status: 'active',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        };
      }
      return null;
    }),
  };
  return {
    getRuntimeControlRepository: () => ({
      listDueWebhookDeliveries: vi.fn(async () => []),
      claimDueWebhookDeliveries: vi.fn(async () => []),
    }),
    getRuntimeRepositories: () => ({
      getAllConversationRoutes: vi.fn(async () => ({})),
      storeChatMetadata: vi.fn(async () => undefined),
      storeMessage: vi.fn(async () => undefined),
    }),
    getRuntimeStorage: () => ({
      repositories: {
        agents: agentsRepo,
        skills: skillsRepo,
        tools: {
          listTools: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(async () => []),
        },
        mcpServers: {
          listAgentBindingsForAgents: vi.fn(async () => []),
        },
        providerAccounts: {
          listProviderAccounts: vi.fn(async () => []),
          listConversationInstalls: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => []),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
        capabilitySecrets: capabilitySecretsRepo,
        pendingAccessRequests: {
          insertPending: vi.fn(async () => undefined),
          markResolved: vi.fn(async () => undefined),
          countPendingAccessRequests: vi.fn(async () => 0),
        },
      },
      skillArtifacts: new LocalSkillArtifactStore(state.artifactRoot),
    }),
  };
});

describe('skill registry integration flow', () => {
  let artifactRoot: string;

  beforeEach(() => {
    vi.mocked(syncRuntimeSettingsFromProjection)
      .mockReset()
      .mockResolvedValue(undefined);
    fs.rmSync('/tmp/gantry-skills-integration-home', {
      recursive: true,
      force: true,
    });
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-skills-'));
    state.artifactRoot = artifactRoot;
    state.skills.clear();
    state.bindings.clear();
    state.secrets.clear();
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createCapabilityReviewDeps(options?: {
    decision?: {
      approved: boolean;
      mode?: string;
      decidedBy?: string;
      reason?: string;
      decisionClassification?: string;
      updatedPermissions?: unknown[];
    };
    groups?: Record<string, any>;
  }) {
    const sendMessage = vi.fn(async () => undefined);
    const mirrorAgentToolRulesToSettings = vi.fn(async () => undefined);
    const toolRepository = {
      getTool: vi.fn(async () => null),
      listTools: vi.fn(async () => []),
      saveTool: vi.fn(async () => undefined),
      saveAgentToolBinding: vi.fn(async () => undefined),
      disableAgentToolBinding: vi.fn(async () => null),
      listAgentToolBindings: vi.fn(async () => []),
    };
    const requestPermissionApproval = vi.fn(
      async () =>
        options?.decision ?? {
          approved: true,
          decidedBy: 'Approver',
          reason: 'approved',
        },
    );
    const deps = {
      conversationRoutes: () =>
        options?.groups ?? {
          'chat-origin': {
            name: 'Agent One Origin',
            folder: 'agent:one',
            jid: 'chat-origin',
          } as any,
        },
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage,
      requestPermissionApproval,
      runApprovedCommand: vi.fn(async (input: any) => {
        const { runApprovedSandboxCommand } =
          await import('@core/adapters/sandbox/approved-command-runner.js');
        await runApprovedSandboxCommand(input);
      }),
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
      getToolRepository: () => toolRepository,
      mirrorAgentToolRulesToSettings,
    };
    return {
      deps,
      sendMessage,
      requestPermissionApproval,
      toolRepository,
      mirrorAgentToolRulesToSettings,
    };
  }

  it('installs, deduplicates, binds, resolves, and disables a local skill through control SDK and services', async () => {
    const server = await startTestControlServer({
      token: 'token-skills',
      appId: 'app-one',
      scopes: ['skills:read', 'skills:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const zip = makeSkillZip({
        'deep-skill/SKILL.md': [
          '---',
          'name: Deep Skill',
          'description: Exercises the control-to-artifact skill flow',
          '---',
          '# Deep Skill',
        ].join('\n'),
        'deep-skill/prompts/main.md': 'Do a useful thing.',
      });

      const uploaded = await client.skills.install({
        agentId: 'agent:one',
        createdBy: 'admin-user',
        zip,
      });
      const installed = SkillCatalogItemResponseSchema.parse(
        (uploaded as any).skill,
      );
      expect(installed).toMatchObject({
        appId: 'app-one',
        name: 'Deep Skill',
        status: 'installed',
        createdBy: 'admin-user',
      });
      expect(installed.storage?.storageType).toBe('local-filesystem');
      expect(
        fs.existsSync(
          path.join(artifactRoot, installed.storage?.storageRef ?? ''),
        ),
      ).toBe(true);

      const duplicate = await client.skills.install({
        agentId: 'agent:one',
        createdBy: 'admin-user',
        zip,
      });
      expect((duplicate as any).skill.id).toBe(installed.id);
      expect(state.skills).toHaveLength(1);

      const binding = await client.agents.skills.enable(
        'agent:one',
        installed.id,
      );
      expect((binding as any).binding).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        skillId: installed.id,
        status: 'active',
      });

      const storage =
        await import('@core/adapters/storage/postgres/runtime-store.js');
      const localSkills = await storage
        .getRuntimeStorage()
        .repositories.skills.listEnabledSkillsForAgent({
          appId: 'app-one',
          agentId: 'agent:one',
        });
      expect(localSkills.map((skill: StoredSkill) => skill.id)).toEqual([
        installed.id,
      ]);

      const disabled = await client.agents.skills.disable(
        'agent:one',
        installed.id,
      );
      expect(disabled.disabled).toBe(true);
      await expect(
        storage
          .getRuntimeStorage()
          .repositories.skills.listEnabledSkillsForAgent({
            appId: 'app-one',
            agentId: 'agent:one',
          }),
      ).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('rolls back Control API skill bindings when settings sync fails', async () => {
    state.skills.set('skill:installed', {
      id: 'skill:installed',
      appId: 'app-one',
      name: 'Installed Skill',
      source: 'admin_uploaded',
      status: 'installed',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    vi.mocked(syncRuntimeSettingsFromProjection).mockRejectedValueOnce(
      new Error('settings sync failed'),
    );
    const server = await startTestControlServer({
      token: 'token-skills',
      appId: 'app-one',
      scopes: ['skills:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      await expect(
        client.agents.skills.enable('agent:one', 'skill:installed'),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
      expect([...state.bindings.values()]).toEqual([
        expect.objectContaining({
          appId: 'app-one',
          agentId: 'agent:one',
          skillId: 'skill:installed',
          status: 'disabled',
        }),
      ]);
      expect(state.skills.get('skill:installed')).toMatchObject({
        status: 'installed',
      });
    } finally {
      await server.close();
    }
  });

  it('rejects cross-app skill actions before artifact or binding mutation', async () => {
    const server = await startTestControlServer({
      token: 'token-skills',
      appId: 'app-one',
      scopes: ['skills:read', 'skills:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const zip = makeSkillZip({
        'SKILL.md': '# Cross App',
      });
      await expect(
        client.skills.install({ appId: 'app-two', zip }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(state.skills).toHaveLength(0);

      state.skills.set('skill:installed', {
        id: 'skill:installed',
        appId: 'default',
        name: 'Installed',
        source: 'admin_uploaded',
        status: 'installed',
        promptRefs: [],
        toolIds: [],
        workflowRefs: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
      await expect(
        client.agents.skills.enable('agent:one', 'skill:installed', {
          appId: 'app-two',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        client.agents.skills.enable('agent:other', 'skill:installed'),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      expect(state.bindings).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('rejects malformed skill zip uploads before persisting skills or artifacts', async () => {
    const server = await startTestControlServer({
      token: 'token-skills',
      appId: 'app-one',
      scopes: ['skills:read', 'skills:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      await expect(
        client.skills.install({
          zip: Buffer.from('not-a-zip-file'),
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });

      await expect(
        client.skills.install({
          zip: makeSkillZip({ 'README.md': '# Missing required skill file' }),
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });

      expect(state.skills.size).toBe(0);
      expect(state.bindings.size).toBe(0);
      expect(fs.readdirSync(artifactRoot)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it.each([
    [
      'request_skill_dependency_install',
      {
        ecosystem: 'npm',
        packages: ['tsx'],
        commandArgv: ['npm', 'install', 'tsx'],
        skillName: 'Release Notes',
        reason: 'The reviewed skill needs tsx.',
      },
      {
        ecosystem: 'npm',
        packages: ['tsx'],
        commandArgv: ['npm', 'install', 'tsx'],
        skillName: 'Release Notes',
        effect: 'review_only_no_command_execution',
      },
    ],
    [
      'request_permission',
      {
        permissionKind: 'tool',
        toolName: 'Bash',
        toolNames: ['Read'],
        rule: 'npm run test *',
        temporaryOnly: false,
        broadAccess: false,
        toolCategory: 'sdk',
        permissionPolicy: 'persistent',
        sandboxProfile: 'workspace-write',
        reason: 'Run project tests and inspect files.',
      },
      {
        permissionKind: 'tool',
        toolNames: ['Bash', 'Read'],
        rule: 'npm run test *',
        temporaryOnly: false,
        broadAccess: false,
        toolCategory: 'sdk',
        permissionPolicy: 'persistent',
        sandboxProfile: 'workspace-write',
        effect: 'review_only_no_permission_change',
      },
    ],
  ])(
    'routes %s through same-channel permission review without binding',
    async (type, payload, expectedToolInput) => {
      const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
      const { deps, sendMessage, requestPermissionApproval } =
        createCapabilityReviewDeps();

      await processTaskIpc(
        {
          type,
          appId: 'app-one',
          taskId: `${type}-approve-test`,
          targetJid: 'chat-origin',
          chatJid: 'chat-origin',
          authThreadId: 'thread-origin',
          payload,
        },
        'agent:one',
        deps as any,
      );

      await vi.waitFor(() => {
        expect(requestPermissionApproval).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceAgentFolder: 'agent:one',
            targetJid: 'chat-origin',
            threadId: 'thread-origin',
            decisionPolicy: 'same_channel',
            toolName: type,
            toolInput: expect.objectContaining(expectedToolInput),
          }),
        );
      });
      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith(
          'chat-origin',
          expect.stringContaining('Approved'),
          { threadId: 'thread-origin' },
        );
      });
      expect([...state.skills.values()]).toEqual([]);
      expect([...state.bindings.values()]).toEqual([]);
    },
  );

  it('installs requested skill packages after same-channel approval', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    const deps = {
      conversationRoutes: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage,
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };

    await processTaskIpc(
      {
        type: 'request_skill_install',
        appId: 'app-one',
        taskId: 'request-skill-install-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          dependencies: ['npm:@linkedin/client'],
          reason: 'Reuse a reviewed posting workflow.',
          files: [
            {
              path: 'SKILL.md',
              content: [
                '---',
                'name: LinkedIn Posting',
                'description: Drafts LinkedIn posts',
                '---',
                '# LinkedIn Posting',
              ].join('\n'),
            },
          ],
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAgentFolder: 'agent:one',
          targetJid: 'chat-origin',
          threadId: 'thread-origin',
          decisionPolicy: 'same_channel',
          toolName: 'request_skill_install',
          appId: 'app-one',
          agentId: 'agent:one',
          toolInput: expect.objectContaining({
            activation: 'current_and_future_sessions',
            files: [
              expect.objectContaining({
                path: 'SKILL.md',
                sizeBytes: expect.any(Number),
                contentHash: expect.stringMatching(/^sha256:/),
              }),
            ],
          }),
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Installed skill LinkedIn Posting'),
        { threadId: 'thread-origin' },
      );
    });

    const approved = [...state.skills.values()].filter(
      (skill) => skill.status === 'installed',
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      name: 'LinkedIn Posting',
    });
    expect([...state.bindings.values()]).toEqual([
      expect.objectContaining({
        appId: 'app-one',
        agentId: 'agent:one',
        skillId: approved[0].id,
        status: 'active',
      }),
    ]);
    expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
  });

  it('replaces the current same-name skill package without creating duplicate installed rows', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const { deps } = createCapabilityReviewDeps();

    const installSkill = async (taskId: string, heading: string) => {
      await processTaskIpc(
        {
          type: 'request_skill_install',
          appId: 'app-one',
          taskId,
          targetJid: 'chat-origin',
          chatJid: 'chat-origin',
          authThreadId: 'thread-origin',
          payload: {
            reason: 'Reuse a reviewed posting workflow.',
            files: [
              {
                path: 'SKILL.md',
                content: [
                  '---',
                  'name: LinkedIn Posting',
                  'description: Drafts LinkedIn posts',
                  '---',
                  heading,
                ].join('\n'),
              },
            ],
          },
        },
        'agent:one',
        deps as any,
      );
    };

    await installSkill('request-skill-install-v1', '# LinkedIn Posting');
    await vi.waitFor(() => {
      expect(
        [...state.bindings.values()].filter(
          (binding) => binding.status === 'active',
        ),
      ).toHaveLength(1);
    });
    const firstActiveSkillId = [...state.bindings.values()].find(
      (binding) => binding.status === 'active',
    )?.skillId;

    await installSkill('request-skill-install-v2', '# LinkedIn Posting v2');
    await vi.waitFor(() => {
      const activeBindings = [...state.bindings.values()].filter(
        (binding) => binding.status === 'active',
      );
      const disabledBindings = [...state.bindings.values()].filter(
        (binding) => binding.status === 'disabled',
      );
      expect(activeBindings).toHaveLength(1);
      expect(disabledBindings).toEqual([]);
    });

    const approved = [...state.skills.values()].filter(
      (skill) => skill.status === 'installed',
    );
    const activeBinding = [...state.bindings.values()].find(
      (binding) => binding.status === 'active',
    );
    expect(approved).toHaveLength(1);
    expect(activeBinding?.skillId).toBe(firstActiveSkillId);

    const storage =
      await import('@core/adapters/storage/postgres/runtime-store.js');
    const enabled = await storage
      .getRuntimeStorage()
      .repositories.skills.listEnabledSkillsForAgent({
        appId: 'app-one',
        agentId: 'agent:one',
      });
    expect(enabled.map((skill: StoredSkill) => skill.id)).toEqual([
      activeBinding?.skillId,
    ]);
    await vi.waitFor(() => {
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(2);
    });
  });

  it('coalesces duplicate pending staged skill install reviews', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    let resolveApproval:
      | ((value: { approved: true; decidedBy: string; reason: string }) => void)
      | undefined;
    const requestPermissionApproval = vi.fn(
      () =>
        new Promise<{ approved: true; decidedBy: string; reason: string }>(
          (resolve) => {
            resolveApproval = resolve;
          },
        ),
    );
    const sendMessage = vi.fn(async () => undefined);
    const deps = {
      conversationRoutes: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage,
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };
    const task = {
      type: 'request_skill_install',
      appId: 'app-one',
      targetJid: 'chat-origin',
      chatJid: 'chat-origin',
      authThreadId: 'thread-origin',
      payload: {
        reason: 'Reuse a reviewed posting workflow.',
        files: [
          {
            path: 'SKILL.md',
            content: [
              '---',
              'name: LinkedIn Posting',
              'description: Drafts LinkedIn posts',
              '---',
              '# LinkedIn Posting',
            ].join('\n'),
          },
        ],
      },
    };

    await processTaskIpc(
      { ...task, taskId: 'request-skill-install-duplicate-1' },
      'agent:one',
      deps as any,
    );
    await processTaskIpc(
      { ...task, taskId: 'request-skill-install-duplicate-2' },
      'agent:one',
      deps as any,
    );

    // The review runs detached; the install-time collision check adds async
    // hops before the approval request, so wait for it instead of asserting
    // on the microtask the handler happens to return on.
    await vi.waitFor(() =>
      expect(requestPermissionApproval).toHaveBeenCalledTimes(1),
    );
    expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    expect([...state.skills.values()]).toHaveLength(0);
    expect([...state.bindings.values()]).toEqual([]);

    resolveApproval?.({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Installed skill LinkedIn Posting'),
        { threadId: 'thread-origin' },
      );
    });
    expect([...state.bindings.values()]).toHaveLength(1);
  });

  it('runs reviewed skill installer commands and enables the produced skill', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const { deps, sendMessage, requestPermissionApproval } =
      createCapabilityReviewDeps();
    const installerScript = [
      "const fs = require('node:fs')",
      "fs.writeFileSync('SKILL.md', ['---', 'name: LinkedIn Posting', 'description: Drafts LinkedIn posts', 'required_env_vars: LINKEDIN_ACCESS_TOKEN', '---', '# LinkedIn Posting'].join('\\n'))",
    ].join(';');

    await processTaskIpc(
      {
        type: 'request_skill_install',
        appId: 'app-one',
        taskId: 'request-skill-command-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          reason: 'Install the LinkedIn posting skill from the catalog.',
          installCommandArgv: [process.execPath, '-e', installerScript],
          requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAgentFolder: 'agent:one',
          targetJid: 'chat-origin',
          threadId: 'thread-origin',
          decisionPolicy: 'same_channel',
          toolName: 'request_skill_install',
          displayName: 'skill LinkedIn posting',
          toolInput: expect.objectContaining({
            installCommandArgv: [process.execPath, '-e', installerScript],
            commandSummary: expect.stringContaining(process.execPath),
            effect:
              'prepares_or_imports_skill_package_and_enables_skill_after_approval',
          }),
        }),
      );
    });
    expect(
      requestPermissionApproval.mock.calls.some((call) =>
        String(call[0]?.displayName).includes('Skill install command:'),
      ),
    ).toBe(false);
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('I installed LinkedIn Posting.'),
        { threadId: 'thread-origin' },
      );
    });
    expect(
      sendMessage.mock.calls.some((call) =>
        String(call[1]).includes('Credential Center'),
      ),
    ).toBe(true);
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(
      'LINKEDIN_ACCESS_TOKEN',
    );
    const approved = [...state.skills.values()].filter(
      (skill) => skill.status === 'installed',
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      name: 'LinkedIn Posting',
      requiredEnvVars: ['LINKEDIN_ACCESS_TOKEN'],
    });
    expect([...state.bindings.values()]).toEqual([
      expect.objectContaining({
        appId: 'app-one',
        agentId: 'agent:one',
        skillId: approved[0].id,
        status: 'active',
      }),
    ]);
  });

  it('sends denial messages for request-only capability reviews without enabling tools', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const { deps, sendMessage, requestPermissionApproval } =
      createCapabilityReviewDeps({
        decision: {
          approved: false,
          decidedBy: 'Approver',
          reason: 'too broad',
        },
      });

    await processTaskIpc(
      {
        type: 'request_permission',
        appId: 'app-one',
        taskId: 'request-permission-deny-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          toolName: 'Bash',
          permissionKind: 'tool',
          reason: 'Run arbitrary commands.',
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining(
          'Not approved: Permission: Bash. Reason: too broad.',
        ),
        { threadId: 'thread-origin' },
      );
    });
    expect([...state.skills.values()]).toEqual([]);
    expect([...state.bindings.values()]).toEqual([]);
  });

  it('does not add persistent suggestions for exact third-party MCP request_permission reviews', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const { deps, requestPermissionApproval } = createCapabilityReviewDeps();

    await processTaskIpc(
      {
        type: 'request_permission',
        appId: 'app-one',
        taskId: 'request-permission-persistent-suggestion-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          permissionKind: 'tool',
          toolName: 'mcp__internal__deploy_preview',
          rule: 'environment:staging',
          temporaryOnly: false,
          reason: 'Deploy previews repeatedly during this session.',
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'request_permission',
          suggestions: undefined,
        }),
      );
    });
  });

  it('rejects temporary Browser request_permission activation before review', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const { deps, requestPermissionApproval, sendMessage } =
      createCapabilityReviewDeps();

    await processTaskIpc(
      {
        type: 'request_permission',
        appId: 'app-one',
        taskId: 'request-permission-temporary-browser-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          permissionKind: 'tool',
          toolName: 'Browser',
          temporaryOnly: true,
          reason: 'Use browser action tools in this run.',
        },
      },
      'agent:one',
      deps as any,
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('persists catalog semantic capability approvals as configured capability rules', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const {
      deps,
      sendMessage,
      toolRepository,
      mirrorAgentToolRulesToSettings,
    } = createCapabilityReviewDeps({
      decision: {
        approved: true,
        mode: 'allow_persistent_rule',
        decidedBy: 'Approver',
        reason: 'persistent tool allowed',
        decisionClassification: 'user_permanent',
        updatedPermissions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [
              {
                toolName: 'capability:acme.records.append',
              },
            ],
          },
        ],
      },
    });
    const capabilityDefinition = {
      capabilityId: 'acme.records.append',
      displayName: 'Acme records append',
      category: 'Acme Records',
      risk: 'write' as const,
      accountLabel: 'Configured Google access',
      can: 'Read and update spreadsheet values.',
      cannot: 'Change sharing or receive raw OAuth tokens.',
      credentialSource: 'configured_access' as const,
      implementationBindings: [
        { kind: 'adapter' as const, adapterRef: 'adapter:google-records' },
      ],
    };
    toolRepository.listTools.mockResolvedValue([
      {
        id: 'tool:capability:acme.records.append',
        appId: 'app-one',
        name: 'capability:acme.records.append',
        displayName: 'Acme records append',
        adapterRef: 'capability/acme.records.append',
        status: 'active',
        selectable: true,
        inputSchema: semanticCapabilityInputSchema(capabilityDefinition),
      },
    ]);

    await processTaskIpc(
      {
        type: 'request_permission',
        appId: 'app-one',
        taskId: 'request-permission-persistent-approval-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          permissionKind: 'tool',
          capabilityRequestSource: 'request_access',
          capabilityId: 'acme.records.append',
          capabilityDisplayName: 'Acme records append',
          accountLabel: 'Configured Google access',
          can: 'Read and update spreadsheet values.',
          cannot: 'Change sharing or receive raw OAuth tokens.',
          credentialSource: 'configured_access',
          temporaryOnly: false,
          reason:
            'Update the status spreadsheet repeatedly during this session.',
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(toolRepository.saveTool).not.toHaveBeenCalled();
    });
    await vi.waitFor(() => {
      expect(toolRepository.saveAgentToolBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          agentId: 'agent:one',
          toolId: 'tool:capability:acme.records.append',
          status: 'active',
        }),
      );
    });
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'agent:one',
      ['capability:acme.records.append'],
      { appId: 'app-one' },
    );
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining(
          'Allowed Permission: Acme records append. Future matching requests are allowed.',
        ),
        { threadId: 'thread-origin' },
      );
    });
  });

  it('persists Browser request_permission approval as the selected Browser catalog tool', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const {
      deps,
      sendMessage,
      toolRepository,
      mirrorAgentToolRulesToSettings,
    } = createCapabilityReviewDeps({
      decision: {
        approved: true,
        mode: 'allow_persistent_rule',
        decidedBy: 'Approver',
        reason: 'persistent Browser allowed',
        decisionClassification: 'user_permanent',
        updatedPermissions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Browser' }],
          },
        ],
      },
    });
    toolRepository.listTools.mockResolvedValue([
      {
        id: 'tool:Browser',
        appId: 'app-one',
        name: 'Browser',
        status: 'active',
        selectable: true,
      },
    ]);

    await processTaskIpc(
      {
        type: 'request_permission',
        appId: 'app-one',
        taskId: 'request-permission-browser-persistent-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          permissionKind: 'tool',
          toolName: 'Browser',
          temporaryOnly: false,
          reason: 'Use persistent browser action tools on future runs.',
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(toolRepository.saveAgentToolBinding).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          agentId: 'agent:one',
          toolId: 'tool:Browser',
          status: 'active',
        }),
      );
    });
    expect(toolRepository.saveTool).not.toHaveBeenCalled();
    expect(mirrorAgentToolRulesToSettings).toHaveBeenCalledWith(
      'agent:one',
      ['Browser'],
      { appId: 'app-one' },
    );
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining(
          'Allowed Permission: Browser. Future matching requests are allowed.',
        ),
        { threadId: 'thread-origin' },
      );
    });
  });

  it('does not persist request_permission updatedPermissions without a permanent decision', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const { deps, toolRepository } = createCapabilityReviewDeps({
      decision: {
        approved: true,
        mode: 'allow_once',
        decidedBy: 'Approver',
        reason: 'allowed once',
        decisionClassification: 'user_temporary',
        updatedPermissions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }],
          },
        ],
      },
    });

    await processTaskIpc(
      {
        type: 'request_permission',
        appId: 'app-one',
        taskId: 'request-permission-allow-once-no-persist-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          permissionKind: 'tool',
          toolName: 'Bash',
          reason: 'Run one command.',
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(toolRepository.saveTool).not.toHaveBeenCalled();
      expect(toolRepository.saveAgentToolBinding).not.toHaveBeenCalled();
    });
  });

  it('rejects request-only capability approval target overrides', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const { deps, sendMessage, requestPermissionApproval } =
      createCapabilityReviewDeps({
        groups: {
          'chat-origin': {
            name: 'Agent One Origin',
            folder: 'agent:one',
            jid: 'chat-origin',
          } as any,
          'chat-admin-dm': {
            name: 'Agent One Admin DM',
            folder: 'agent:one',
            jid: 'chat-admin-dm',
          } as any,
        },
      });

    await processTaskIpc(
      {
        type: 'request_skill_dependency_install',
        appId: 'default',
        taskId: 'request-skill-dependency-forum-shopping-test',
        chatJid: 'chat-origin',
        targetJid: 'chat-admin-dm',
        payload: {
          ecosystem: 'npm',
          packages: ['tsx'],
          reason: 'Try routing review to another bound chat.',
        },
      },
      'agent:one',
      deps as any,
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect([...state.skills.values()]).toEqual([]);
    expect([...state.bindings.values()]).toEqual([]);
  });

  it('routes agent-created skill proposals through same-channel approval before binding', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    const hiddenReviewTail = 'Do not hide this instruction after preview.';
    const deps = {
      conversationRoutes: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage,
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };

    await processTaskIpc(
      {
        type: 'request_skill_proposal',
        appId: 'app-one',
        taskId: 'request-skill-approve-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          reason: 'Reuse a channel-specific posting workflow.',
          files: [
            {
              path: 'SKILL.md',
              content: [
                '---',
                'name: Channel Posting',
                'description: Drafts channel posts',
                '---',
                '# Channel Posting',
                'x'.repeat(4100),
                hiddenReviewTail,
              ].join('\n'),
            },
          ],
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAgentFolder: 'agent:one',
          targetJid: 'chat-origin',
          threadId: 'thread-origin',
          decisionPolicy: 'same_channel',
          toolName: 'request_skill_proposal',
          appId: 'app-one',
          agentId: 'agent:one',
        }),
      );
    });
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInput: expect.objectContaining({
          skillMarkdownPreview: expect.objectContaining({
            path: 'SKILL.md',
            content: expect.stringContaining('name: Channel Posting'),
            truncated: true,
          }),
          files: [
            expect.objectContaining({
              path: 'SKILL.md',
              sizeBytes: expect.any(Number),
              contentHash: expect.stringMatching(/^sha256:/),
            }),
          ],
        }),
        interaction: expect.objectContaining({
          files: [
            expect.objectContaining({
              path: 'SKILL.md',
              preview: expect.stringContaining(hiddenReviewTail),
              truncated: false,
            }),
          ],
        }),
      }),
    );
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Installed skill Channel Posting'),
        { threadId: 'thread-origin' },
      );
    });

    const approved = [...state.skills.values()].filter(
      (skill) => skill.status === 'installed',
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      name: 'Channel Posting',
      source: 'agent_created',
      createdBy: 'Approver',
    });
    expect([...state.bindings.values()]).toEqual([
      expect.objectContaining({
        appId: 'app-one',
        agentId: 'agent:one',
        skillId: approved[0].id,
        status: 'active',
      }),
    ]);
    expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
    expect(syncRuntimeSettingsFromProjection).toHaveBeenLastCalledWith(
      expect.objectContaining({ appId: 'app-one' }),
    );
  });

  it('rolls back installed skill proposal bindings when settings sync fails', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    vi.mocked(syncRuntimeSettingsFromProjection).mockRejectedValueOnce(
      new Error('settings sync failed'),
    );
    const deps = {
      conversationRoutes: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage,
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };

    await processTaskIpc(
      {
        type: 'request_skill_proposal',
        appId: 'app-one',
        taskId: 'request-skill-sync-failure-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          reason: 'Reuse a channel-specific posting workflow.',
          files: [
            {
              path: 'SKILL.md',
              content: [
                '---',
                'name: Rollback Skill',
                'description: Drafts channel posts',
                '---',
                '# Rollback Skill',
              ].join('\n'),
            },
          ],
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
    });
    const skills = [...state.skills.values()];
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: 'Rollback Skill',
      status: 'installed',
    });
    expect([...state.bindings.values()]).toEqual([
      expect.objectContaining({
        appId: 'app-one',
        agentId: 'agent:one',
        skillId: skills[0].id,
        status: 'disabled',
      }),
    ]);
    expect(sendMessage).not.toHaveBeenCalledWith(
      'chat-origin',
      expect.stringContaining('Approved skill Rollback Skill'),
      { threadId: 'thread-origin' },
    );
  });

  it('rejects agent-created skill packages when SKILL.md cannot be fully shown for channel approval', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    const deps = {
      conversationRoutes: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };

    await processTaskIpc(
      {
        type: 'request_skill_proposal',
        taskId: 'request-skill-large-md-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          reason: 'Test oversized review path.',
          files: [
            {
              path: 'SKILL.md',
              content: [
                '---',
                'name: Oversized Capability',
                'description: Too large for channel review',
                '---',
                '# Oversized Capability',
                'x'.repeat(4_001),
              ].join('\n'),
            },
          ],
        },
      },
      'agent:one',
      deps as any,
    );

    expect(requestPermissionApproval).not.toHaveBeenCalled();
    expect(state.skills.size).toBe(0);
    expect(state.bindings.size).toBe(0);
  });

  it('does not bind agent-created skill proposals when same-channel approval denies', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(async () => ({
      approved: false,
      decidedBy: 'Approver',
      reason: 'not approved',
    }));
    const deps = {
      conversationRoutes: () => ({
        'chat-origin': {
          name: 'Agent One Origin',
          folder: 'agent:one',
          jid: 'chat-origin',
        } as any,
      }),
      syncGroups: vi.fn(async () => undefined),
      getAvailableGroups: vi.fn(async () => []),
      writeGroupsSnapshot: vi.fn(async () => undefined),
      sendMessage,
      requestPermissionApproval,
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };

    await processTaskIpc(
      {
        type: 'request_skill_proposal',
        appId: 'app-one',
        taskId: 'request-skill-deny-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          reason: 'Test denied review path.',
          files: [
            {
              path: 'SKILL.md',
              content: [
                '---',
                'name: Denied Capability',
                'description: Should be rejected',
                '---',
                '# Denied Capability',
              ].join('\n'),
            },
          ],
        },
      },
      'agent:one',
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceAgentFolder: 'agent:one',
          targetJid: 'chat-origin',
          threadId: 'thread-origin',
          decisionPolicy: 'same_channel',
          toolName: 'request_skill_proposal',
          appId: 'app-one',
          agentId: 'agent:one',
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Did not install skill Denied Capability'),
        { threadId: 'thread-origin' },
      );
    });

    const denied = [...state.skills.values()].filter(
      (skill) => skill.name === 'Denied Capability',
    );
    expect(denied).toHaveLength(0);
    expect([...state.bindings.values()]).toEqual([]);
  });

  it('handles reserved URL skill ids through binding routes', async () => {
    const server = await startTestControlServer({
      token: 'token-skills',
      appId: 'app-one',
      scopes: ['skills:read', 'skills:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });
    const reservedSkillId = 'skill:release/slash';
    const storage = await new LocalSkillArtifactStore(
      artifactRoot,
    ).putSkillArtifact({
      appId: 'app-one',
      skillId: reservedSkillId,
      skillName: 'Slash Skill',
      bundle: {
        assets: [
          {
            path: 'SKILL.md',
            contentType: 'text/markdown',
            content: Buffer.from('---\nname: Slash Skill\n---\n# Slash Skill'),
          },
        ],
      },
    });

    state.skills.set(reservedSkillId, {
      id: reservedSkillId,
      appId: 'app-one',
      agentId: 'agent:one',
      name: 'Slash Skill',
      source: 'admin_uploaded',
      status: 'installed',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    try {
      const enabled = await client.agents.skills.enable(
        'agent:one',
        reservedSkillId,
      );
      expect((enabled as any).binding).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        skillId: reservedSkillId,
        status: 'active',
      });

      const disabled = await client.agents.skills.disable(
        'agent:one',
        reservedSkillId,
      );
      expect(disabled).toMatchObject({
        disabled: true,
      });
      expect((disabled as any).binding).toMatchObject({
        skillId: reservedSkillId,
        status: 'disabled',
      });
    } finally {
      await server.close();
    }
  });
});
