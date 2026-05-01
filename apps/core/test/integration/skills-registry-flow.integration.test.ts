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
} from '@myclaw/contracts';
import { createClient } from '../../../../packages/sdk/src/index.js';

type StoredSkill = SkillCatalogItemResponse;

const state = vi.hoisted(() => ({
  artifactRoot: '',
  skills: new Map<string, StoredSkill>(),
  bindings: new Map<string, any>(),
}));

vi.mock('@core/config/index.js', () => ({
  MYCLAW_HOME: '/tmp/myclaw-skills-integration-home',
  ONECLI_ALLOWED_ENV_KEYS: [],
  MYCLAW_IPC_AUTH_SECRET: 'test-ipc-secret',
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
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
            Boolean(skill) && skill.status === 'approved',
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  };
  const agentsRepo = {
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
    getRuntimeOpsRepository: () => ({
      storeChatMetadata: vi.fn(async () => undefined),
      storeMessage: vi.fn(async () => undefined),
    }),
    getRuntimeStorage: () => ({
      repositories: { agents: agentsRepo, skills: skillsRepo },
      skillArtifacts: new LocalSkillArtifactStore(state.artifactRoot),
    }),
  };
});

describe('skill registry integration flow', () => {
  let artifactRoot: string;

  beforeEach(() => {
    artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-skills-'));
    state.artifactRoot = artifactRoot;
    state.skills.clear();
    state.bindings.clear();
  });

  afterEach(() => {
    fs.rmSync(artifactRoot, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function createCapabilityReviewDeps(options?: {
    decision?: { approved: boolean; decidedBy?: string; reason?: string };
    groups?: Record<string, any>;
  }) {
    const sendMessage = vi.fn(async () => undefined);
    const requestPermissionApproval = vi.fn(
      async () =>
        options?.decision ?? {
          approved: true,
          decidedBy: 'Approver',
          reason: 'approved',
        },
    );
    const deps = {
      registeredGroups: () =>
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
      requestUserAnswer: vi.fn(),
      onSchedulerChanged: vi.fn(),
      registerGroup: vi.fn(),
    };
    return { deps, sendMessage, requestPermissionApproval };
  }

  it('uploads, deduplicates, approves, binds, resolves, and disables a local skill through control SDK and services', async () => {
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

      const uploaded = await client.skillDrafts.upload({
        agentId: 'agent:one',
        createdBy: 'admin-user',
        zip,
      });
      const draft = SkillCatalogItemResponseSchema.parse(
        (uploaded as any).draft,
      );
      expect(draft).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        name: 'Deep Skill',
        status: 'draft',
        createdBy: 'admin-user',
      });
      expect(draft.storage?.storageType).toBe('local-filesystem');
      expect(
        fs.existsSync(path.join(artifactRoot, draft.storage?.storageRef ?? '')),
      ).toBe(true);

      const duplicate = await client.skillDrafts.upload({
        agentId: 'agent:one',
        createdBy: 'admin-user',
        zip,
      });
      expect((duplicate as any).draft.id).toBe(draft.id);
      expect(state.skills).toHaveLength(1);

      const approved = await client.skillDrafts.approve(draft.id, {
        approvedBy: 'reviewer',
      });
      expect((approved as any).skill.status).toBe('approved');

      const binding = await client.agents.skills.enable('agent:one', draft.id);
      expect((binding as any).binding).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        skillId: draft.id,
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
        draft.id,
      ]);

      const disabled = await client.agents.skills.disable(
        'agent:one',
        draft.id,
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
        client.skillDrafts.upload({ appId: 'app-two', zip }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(state.skills).toHaveLength(0);

      state.skills.set('skill:approved', {
        id: 'skill:approved',
        appId: 'app-one',
        name: 'Approved',
        version: 'v1',
        source: 'admin_uploaded',
        status: 'approved',
        promptRefs: [],
        toolIds: [],
        workflowRefs: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      });
      await expect(
        client.agents.skills.enable('agent:one', 'skill:approved', {
          appId: 'app-two',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(
        client.agents.skills.enable('agent:other', 'skill:approved'),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });
      expect(state.bindings).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('rejects malformed skill zip uploads before persisting drafts or artifacts', async () => {
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
        client.skillDrafts.upload({
          zip: Buffer.from('not-a-zip-file'),
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });

      await expect(
        client.skillDrafts.upload({
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
      'request_skill_install',
      {
        spec: 'clawhub:release-notes@1.0.0',
        provider: 'clawhub',
        slug: 'release-notes',
        version: '1.0.0',
        publisher: 'ClawHub',
        reason: 'Reuse a reviewed release workflow.',
      },
      {
        spec: 'clawhub:release-notes@1.0.0',
        provider: 'clawhub',
        slug: 'release-notes',
        version: '1.0.0',
        effect: 'review_only_no_direct_install',
      },
    ],
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
      'request_tool_enable',
      {
        toolName: 'Bash',
        toolNames: ['Read'],
        toolCategory: 'sdk',
        permissionPolicy: 'prompt',
        sandboxProfile: 'workspace-write',
        reason: 'Run project tests and inspect files.',
      },
      {
        toolNames: ['Bash', 'Read'],
        toolCategory: 'sdk',
        permissionPolicy: 'prompt',
        sandboxProfile: 'workspace-write',
        effect: 'review_only_no_permission_change',
      },
    ],
    [
      'request_channel_tool_enable',
      {
        channelTool: 'slack_file_access',
        channelProvider: 'slack',
        requiredScopes: ['files:read'],
        affectedConversations: ['C123'],
        reason: 'Read files shared in the active channel.',
      },
      {
        channelTool: 'slack_file_access',
        channelProvider: 'slack',
        requiredScopes: ['files:read'],
        affectedConversations: ['C123'],
        effect: 'review_only_no_channel_permission_change',
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
          taskId: `${type}-approve-test`,
          targetJid: 'chat-origin',
          chatJid: 'chat-origin',
          authThreadId: 'thread-origin',
          payload,
        },
        'agent:one',
        false,
        deps as any,
      );

      await vi.waitFor(() => {
        expect(requestPermissionApproval).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceGroup: 'agent:one',
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
        type: 'request_tool_enable',
        taskId: 'request-tool-deny-test',
        targetJid: 'chat-origin',
        chatJid: 'chat-origin',
        authThreadId: 'thread-origin',
        payload: {
          toolName: 'Bash',
          reason: 'Run arbitrary commands.',
        },
      },
      'agent:one',
      false,
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Rejected Tool enable: Bash: too broad'),
        { threadId: 'thread-origin' },
      );
    });
    expect([...state.skills.values()]).toEqual([]);
    expect([...state.bindings.values()]).toEqual([]);
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
        type: 'request_channel_tool_enable',
        taskId: 'request-channel-tool-forum-shopping-test',
        chatJid: 'chat-origin',
        targetJid: 'chat-admin-dm',
        payload: {
          channelTool: 'slack_file_access',
          channelProvider: 'slack',
          reason: 'Try routing review to another bound chat.',
        },
      },
      'agent:one',
      false,
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
    const deps = {
      registeredGroups: () => ({
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
              ].join('\n'),
            },
          ],
        },
      },
      'agent:one',
      false,
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceGroup: 'agent:one',
          targetJid: 'chat-origin',
          threadId: 'thread-origin',
          decisionPolicy: 'same_channel',
          toolName: 'request_skill_proposal',
        }),
      );
    });
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolInput: expect.objectContaining({
          packageContentHash: expect.stringMatching(/^sha256:/),
          skillMarkdownPreview: expect.objectContaining({
            path: 'SKILL.md',
            content: expect.stringContaining('name: Channel Posting'),
            truncated: false,
            contentHash: expect.stringMatching(/^sha256:/),
          }),
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
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Approved skill Channel Posting'),
        { threadId: 'thread-origin' },
      );
    });

    const approved = [...state.skills.values()].filter(
      (skill) => skill.status === 'approved',
    );
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({
      agentId: 'agent:one',
      name: 'Channel Posting',
      source: 'agent_created',
      createdBy: 'agent:agent:one',
    });
    expect([...state.bindings.values()]).toEqual([
      expect.objectContaining({
        appId: 'default',
        agentId: 'agent:one',
        skillId: approved[0].id,
        status: 'active',
      }),
    ]);
  });

  it('rejects agent-created skill drafts when SKILL.md cannot be fully shown for channel approval', async () => {
    const { processTaskIpc } = await import('@core/jobs/ipc-handler.js');
    const requestPermissionApproval = vi.fn(async () => ({
      approved: true,
      decidedBy: 'Approver',
      reason: 'approved',
    }));
    const deps = {
      registeredGroups: () => ({
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
      false,
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
      registeredGroups: () => ({
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
      false,
      deps as any,
    );

    await vi.waitFor(() => {
      expect(requestPermissionApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceGroup: 'agent:one',
          targetJid: 'chat-origin',
          threadId: 'thread-origin',
          decisionPolicy: 'same_channel',
          toolName: 'request_skill_proposal',
        }),
      );
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'chat-origin',
        expect.stringContaining('Rejected skill Denied Capability'),
        { threadId: 'thread-origin' },
      );
    });

    const denied = [...state.skills.values()].filter(
      (skill) =>
        skill.name === 'Denied Capability' && skill.status === 'rejected',
    );
    expect(denied).toHaveLength(1);
    expect([...state.bindings.values()]).toEqual([]);
  });

  it('handles reserved URL skill ids through approve and binding routes', async () => {
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

    state.skills.set(reservedSkillId, {
      id: reservedSkillId,
      appId: 'app-one',
      agentId: 'agent:one',
      name: 'Slash Skill',
      version: 'v1',
      source: 'admin_uploaded',
      status: 'draft',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      storage: {
        storageType: 'local-filesystem',
        storageRef: 'skills/slash-skill',
        contentHash: 'sha256:slash',
        sizeBytes: 42,
      },
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });

    try {
      const approved = await client.skillDrafts.approve(reservedSkillId, {
        approvedBy: 'reviewer',
      });
      expect((approved as any).skill).toMatchObject({
        id: reservedSkillId,
        status: 'approved',
      });

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
