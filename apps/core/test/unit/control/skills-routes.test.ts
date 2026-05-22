import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { syncRuntimeSettingsFromProjection } from '@core/config/index.js';

vi.mock('@core/config/index.js', () => ({
  GANTRY_HOME: '/tmp/gantry-control-test-home',
  ONECLI_ALLOWED_ENV_KEYS: [],
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
  getRuntimeModelDefaults: vi.fn(() => ({ defaults: {} })),
  patchRuntimeModelDefaults: vi.fn(() => ({ ok: true })),
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

const controlRepo = {
  listDueWebhookDeliveries: vi.fn(async () => []),
  claimDueWebhookDeliveries: vi.fn(async () => []),
};

const opsRepo = {
  getAllConversationRoutes: vi.fn(async () => ({})),
  storeChatMetadata: vi.fn(async () => undefined),
  storeMessage: vi.fn(async () => undefined),
};

type StoredSkill = {
  id: string;
  appId: string;
  agentId?: string;
  name: string;
  status: 'draft' | 'approved' | 'rejected' | 'disabled';
  version: string;
  source: 'admin_uploaded' | 'agent_created' | 'bundled';
  promptRefs: string[];
  toolIds: string[];
  workflowRefs: string[];
  storage?: {
    storageType: 'local-filesystem';
    storageRef: string;
    contentHash: string;
    sizeBytes: number;
  };
  createdAt: string;
  updatedAt: string;
};

const skillsRepo = {
  skills: new Map<string, StoredSkill>(),
  bindings: new Map<string, any>(),
  getSkill: vi.fn(async (id: string) => skillsRepo.skills.get(id) ?? null),
  listSkills: vi.fn(async (input: any) =>
    [...skillsRepo.skills.values()].filter(
      (skill) =>
        skill.appId === input.appId &&
        (!input.agentId || (skill as any).agentId === input.agentId) &&
        (!input.statuses || input.statuses.includes(skill.status)),
    ),
  ),
  saveSkill: vi.fn(async (skill: StoredSkill) => {
    skillsRepo.skills.set(skill.id, skill);
  }),
  getSkillByContentHash: vi.fn(
    async (input: any) =>
      [...skillsRepo.skills.values()].find(
        (skill) =>
          skill.appId === input.appId &&
          skill.storage?.contentHash === input.contentHash &&
          (input.agentId === null
            ? !skill.agentId
            : !input.agentId || skill.agentId === input.agentId) &&
          (!input.statuses || input.statuses.includes(skill.status)),
      ) ?? null,
  ),
  saveAgentSkillBinding: vi.fn(async (binding: any) => {
    skillsRepo.bindings.set(
      `${binding.appId}:${binding.agentId}:${binding.skillId}`,
      binding,
    );
  }),
  disableAgentSkillBinding: vi.fn(async (input: any) => {
    const key = `${input.appId}:${input.agentId}:${input.skillId}`;
    const existing = skillsRepo.bindings.get(key);
    if (!existing) return null;
    const disabled = {
      ...existing,
      status: 'disabled',
      updatedAt: input.updatedAt,
    };
    skillsRepo.bindings.set(key, disabled);
    return disabled;
  }),
  listAgentSkillBindings: vi.fn(async (input: any) =>
    [...skillsRepo.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId && binding.agentId === input.agentId,
    ),
  ),
  listAgentSkillBindingsForAgents: vi.fn(async (input: any) =>
    [...skillsRepo.bindings.values()].filter(
      (binding) =>
        binding.appId === input.appId &&
        input.agentIds.includes(binding.agentId),
    ),
  ),
  listEnabledSkillsForAgent: vi.fn(async (input: any) => {
    const skills: StoredSkill[] = [];
    for (const binding of skillsRepo.bindings.values()) {
      if (
        binding.appId !== input.appId ||
        binding.agentId !== input.agentId ||
        binding.status !== 'active'
      ) {
        continue;
      }
      const skill = skillsRepo.skills.get(binding.skillId);
      if (skill?.status === 'approved') skills.push(skill);
    }
    return skills;
  }),
};

const agentsRepo = {
  getAgent: vi.fn(async (agentId: string) => {
    if (agentId === 'agent:other-app') {
      return {
        id: agentId,
        appId: 'app-two',
        name: 'Other app agent',
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    }
    return {
      id: agentId,
      appId: 'app-one',
      name: 'Agent one',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }),
  listAgents: vi.fn(async (appId: string) => [
    {
      id: 'agent:one',
      appId,
      name: 'Agent one',
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ]),
};

const toolsRepo = {
  getTool: vi.fn(async () => null),
  listTools: vi.fn(async () => []),
  listAgentToolBindings: vi.fn(async () => []),
  listAgentToolBindingsForAgents: vi.fn(async () => []),
};

const mcpServersRepo = {
  getServer: vi.fn(async () => null),
  listAgentBindings: vi.fn(async () => []),
  listAgentBindingsForAgents: vi.fn(async () => []),
};

const providerConnectionsRepo = {
  listProviderConnections: vi.fn(async () => []),
  listAgentConversationBindings: vi.fn(async () => []),
};

const conversationsRepo = {
  listConversations: vi.fn(async () => []),
  listConversationApproversForConversations: vi.fn(async () => []),
};

const skillArtifacts = {
  putSkillArtifact: vi.fn(async (input: any) => ({
    storageType: 'local-filesystem',
    storageRef: `skills/${input.skillId}.json`,
    contentHash: 'sha256:abc123',
    sizeBytes: input.bundle.assets.reduce(
      (sum: number, asset: any) => sum + asset.content.byteLength,
      0,
    ),
  })),
  getSkillArtifact: vi.fn(async () => ({ assets: [] })),
};

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeControlRepository: () => controlRepo,
  getRuntimeRepositories: () => opsRepo,
  getRuntimeStorage: () => ({
    repositories: {
      agents: agentsRepo,
      skills: skillsRepo,
      tools: toolsRepo,
      mcpServers: mcpServersRepo,
      providerConnections: providerConnectionsRepo,
      conversations: conversationsRepo,
    },
    skillArtifacts,
  }),
}));

import { startControlServer } from '@core/control/server/index.js';

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not reserve test port'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function requestWithRetry(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const deadline = Date.now() + 3000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.headers || {}),
        },
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

beforeEach(() => {
  vi.clearAllMocks();
  opsRepo.getAllConversationRoutes.mockResolvedValue({});
  skillsRepo.skills.clear();
  skillsRepo.bindings.clear();
  skillsRepo.skills.set('skill:approved', {
    id: 'skill:approved',
    appId: 'app-one',
    name: 'Approved skill',
    version: 'v1',
    source: 'admin_uploaded',
    status: 'approved',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    storage: {
      storageType: 'local-filesystem',
      storageRef: 'skills/approved/hash',
      contentHash: 'sha256:approved',
      sizeBytes: 31,
    },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  });
  skillArtifacts.getSkillArtifact.mockResolvedValue({
    assets: [
      {
        path: 'SKILL.md',
        contentType: 'text/markdown',
        content: Buffer.from('# Approved\n'),
      },
      {
        path: 'references/context.md',
        contentType: 'text/markdown',
        content: Buffer.from('Context\n'),
      },
      {
        path: 'images/pixel.png',
        contentType: 'image/png',
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    ],
  });
  process.env.GANTRY_CONTROL_API_KEYS_JSON = JSON.stringify([
    {
      kid: 'k',
      token: 'token-skills',
      scopes: ['skills:read', 'skills:admin'],
      appId: 'app-one',
    },
  ]);
});

afterEach(() => {
  delete process.env.GANTRY_CONTROL_API_KEYS_JSON;
  delete process.env.GANTRY_CONTROL_PORT;
});

describe('control skill routes', () => {
  it('rejects skill binding when agent is outside API key app', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent%3Aother-app/skills/skill%3Aapproved`,
        'token-skills',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error?.message).toContain('Agent not found');
      expect(skillsRepo.saveAgentSkillBinding).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects skill binding when request appId conflicts with API key app', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent%3Aone/skills/skill%3Aapproved`,
        'token-skills',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appId: 'app-two' }),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error?.message).toContain('cannot bind for this app');
      expect(skillsRepo.saveAgentSkillBinding).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects draft upload when query appId conflicts with API key app', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/skills/drafts/upload?appId=app-two`,
        'token-skills',
        {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: new Uint8Array([1, 2, 3]),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error?.message).toContain('cannot upload for this app');
      expect(skillArtifacts.putSkillArtifact).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('rejects draft upload when agent belongs to another app', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/skills/drafts/upload?agentId=agent%3Aother-app`,
        'token-skills',
        {
          method: 'POST',
          headers: { 'content-type': 'application/zip' },
          body: new Uint8Array([1, 2, 3]),
        },
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error?.message).toContain('Agent not found');
      expect(skillArtifacts.putSkillArtifact).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('persists skill binding lifecycle for in-app agent', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const enable = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent%3Aone/skills/skill%3Aapproved`,
        'token-skills',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const enableBody = await enable.json();
      expect(enable.status).toBe(200);
      expect(enableBody.binding?.status).toBe('active');
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenLastCalledWith(
        expect.objectContaining({ appId: 'app-one' }),
      );

      const listed = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent%3Aone/skills`,
        'token-skills',
      );
      const listedBody = await listed.json();
      expect(listed.status).toBe(200);
      expect(listedBody.bindings).toHaveLength(1);
      expect(listedBody.bindings[0]?.status).toBe('active');

      const disable = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/agents/agent%3Aone/skills/skill%3Aapproved`,
        'token-skills',
        { method: 'DELETE' },
      );
      const disableBody = await disable.json();
      expect(disable.status).toBe(200);
      expect(disableBody.disabled).toBe(true);
      expect(disableBody.binding?.status).toBe('disabled');
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(2);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenLastCalledWith(
        expect.objectContaining({ appId: 'app-one' }),
      );
    } finally {
      await handle.close();
    }
  });

  it('requires application/zip for draft uploads', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const response = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/skills/drafts/upload?createdBy=admin`,
        'token-skills',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nope: true }),
        },
      );
      const body = await response.json();
      expect(response.status).toBe(415);
      expect(body.error?.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    } finally {
      await handle.close();
    }
  });

  it('lists and reads readable skill files from artifact storage', async () => {
    const port = await reservePort();
    process.env.GANTRY_CONTROL_PORT = String(port);
    const handle = startControlServer({
      app: { queue: { enqueueMessageCheck: vi.fn() } } as never,
    });

    try {
      const list = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/skills/skill%3Aapproved/files`,
        'token-skills',
      );
      const listBody = await list.json();
      expect(list.status).toBe(200);
      expect(listBody.files).toEqual([
        expect.objectContaining({
          path: 'SKILL.md',
          contentType: 'text/markdown',
          sizeBytes: Buffer.byteLength('# Approved\n'),
        }),
        expect.objectContaining({
          path: 'references/context.md',
          contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          path: 'images/pixel.png',
          contentType: 'image/png',
        }),
      ]);

      const read = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/skills/skill%3Aapproved/files/references%2Fcontext.md`,
        'token-skills',
      );
      const readBody = await read.json();
      expect(read.status).toBe(200);
      expect(readBody.file).toMatchObject({
        path: 'references/context.md',
        encoding: 'utf-8',
        content: 'Context\n',
      });
      const readBinary = await requestWithRetry(
        `http://127.0.0.1:${port}/v1/skills/skill%3Aapproved/files/images%2Fpixel.png`,
        'token-skills',
      );
      const readBinaryBody = await readBinary.json();
      expect(readBinary.status).toBe(200);
      expect(readBinaryBody.file).toMatchObject({
        path: 'images/pixel.png',
        encoding: 'base64',
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      });
      expect(skillArtifacts.getSkillArtifact).toHaveBeenCalledWith(
        'skills/approved/hash',
      );
    } finally {
      await handle.close();
    }
  });
});
