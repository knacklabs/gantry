import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/config/index.js', () => ({
  MYCLAW_HOME: '/tmp/myclaw-control-test-home',
  ONECLI_ALLOWED_ENV_KEYS: [],
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

const controlRepo = {
  listDueWebhookDeliveries: vi.fn(async () => []),
  claimDueWebhookDeliveries: vi.fn(async () => []),
};

const opsRepo = {
  storeChatMetadata: vi.fn(async () => undefined),
  storeMessage: vi.fn(async () => undefined),
};

type StoredSkill = {
  id: string;
  appId: string;
  name: string;
  status: 'draft' | 'approved' | 'rejected' | 'disabled';
  version: string;
  source: 'admin_uploaded' | 'agent_created' | 'bundled' | 'provider_managed';
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
  getRuntimeOpsRepository: () => opsRepo,
  getRuntimeStorage: () => ({
    repositories: {
      agents: agentsRepo,
      skills: skillsRepo,
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
    ],
  });
  process.env.MYCLAW_CONTROL_API_KEYS_JSON = JSON.stringify([
    {
      kid: 'k',
      token: 'token-skills',
      scopes: ['skills:read', 'skills:admin'],
      appId: 'app-one',
    },
  ]);
});

afterEach(() => {
  delete process.env.MYCLAW_CONTROL_API_KEYS_JSON;
  delete process.env.MYCLAW_CONTROL_PORT;
});

describe('control skill routes', () => {
  it('rejects skill binding when agent is outside API key app', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
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
    process.env.MYCLAW_CONTROL_PORT = String(port);
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
    process.env.MYCLAW_CONTROL_PORT = String(port);
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

  it('persists skill binding lifecycle for in-app agent', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
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
    } finally {
      await handle.close();
    }
  });

  it('requires application/zip for draft uploads', async () => {
    const port = await reservePort();
    process.env.MYCLAW_CONTROL_PORT = String(port);
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
    process.env.MYCLAW_CONTROL_PORT = String(port);
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
      expect(skillArtifacts.getSkillArtifact).toHaveBeenCalledWith(
        'skills/approved/hash',
      );
    } finally {
      await handle.close();
    }
  });
});
