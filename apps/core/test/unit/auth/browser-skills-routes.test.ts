import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import {
  BrowserInstallSkillResponseSchema,
  BrowserSkillAttachmentsResponseSchema,
  BrowserSkillFileResponseSchema,
  BrowserSkillInventoryResponseSchema,
} from '@gantry/contracts';
import { beforeEach, expect, it, vi } from 'vitest';

import { hashSkillBundle } from '@core/shared/skill-artifact-helpers.js';

const activeSession = vi.hoisted(() => vi.fn());
const requireBrowserMutationSession = vi.hoisted(() => vi.fn());
const parseSkillZipUpload = vi.hoisted(() => vi.fn());
const storage = vi.hoisted(() => ({
  repositories: {
    agents: { listAgents: vi.fn() },
    skills: {
      getSkill: vi.fn(),
      listSkills: vi.fn(),
      saveSkill: vi.fn(),
      listAgentSkillBindingsForAgents: vi.fn(),
      replaceSkillAgentBindings: vi.fn(),
    },
  },
  skillArtifacts: {
    putSkillArtifact: vi.fn(),
    getSkillArtifact: vi.fn(),
  },
}));

vi.mock('@core/control/server/routes/browser-auth.js', () => ({
  activeSession,
  requireBrowserMutationSession,
}));
vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => storage,
}));
vi.mock('@core/control/server/skill-zip-upload.js', () => ({
  MAX_SKILL_ZIP_BYTES: 5 * 1024 * 1024,
  parseSkillZipUpload,
}));

import { handleBrowserSkillRoutes } from '@core/control/server/routes/browser-skills.controller.js';

const NOW = '2026-08-31T00:00:00.000Z';
const settings = {
  authentication: {
    mode: 'hosted' as const,
    canonicalOrigin: 'https://console.example',
  },
};

function request(
  method: string,
  body?: Buffer,
  headers: Record<string, string> = {},
): IncomingMessage {
  const req = Readable.from(body ? [body] : []) as IncomingMessage;
  req.method = method;
  req.headers = headers;
  return req;
}

function response() {
  return {
    statusCode: 0,
    body: '',
    setHeader: vi.fn(),
    end(chunk?: unknown) {
      this.body += chunk ? String(chunk) : '';
      return this;
    },
  } as unknown as ServerResponse & { body: string };
}

function routeContext() {
  return { syncSettingsFromProjection: vi.fn() };
}

beforeEach(() => {
  vi.resetAllMocks();
});

it('maps required credential names without secret values', async () => {
  const viewer = {
    appId: 'app:one',
    userId: 'user:viewer',
    role: 'viewer',
    csrfHash: 'csrf-hash',
    reauthenticatedAt: NOW,
  };
  activeSession.mockResolvedValue(viewer);
  requireBrowserMutationSession.mockResolvedValue(viewer);
  storage.repositories.agents.listAgents.mockResolvedValue([
    {
      id: 'agent:one',
      appId: 'app:one',
      name: 'Agent One',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  storage.repositories.skills.listSkills.mockResolvedValue([
    {
      id: 'skill:one',
      appId: 'app:one',
      name: 'Safe Skill',
      description: 'Visible description',
      source: 'admin_uploaded',
      status: 'installed',
      promptRefs: ['storage:prompt-ref'],
      toolIds: [],
      workflowRefs: [],
      requiredEnvVars: ['PRIVATE_ACCESS_TOKEN'],
      actionPermissions: [
        {
          id: 'read',
          capabilityId: 'skill.safe.read',
          displayName: 'Safe read',
          risk: 'read',
          can: 'Read approved records.',
          cannot: 'Read unrelated records.',
          requiredEnvVars: ['PRIVATE_ACCESS_TOKEN'],
          credentialValues: { PRIVATE_ACCESS_TOKEN: 'super-secret-value' },
          commandTemplates: ['skills/safe/read.py *'],
          networkHosts: ['api.example.com:443'],
        },
      ],
      storage: {
        storageType: 'object-store',
        storageRef: 'private/storage/ref',
        contentHash: 'sha256:private-hash',
        sizeBytes: 42,
      },
      createdBy: 'browser:user:viewer',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  storage.repositories.skills.listAgentSkillBindingsForAgents.mockResolvedValue(
    [
      {
        id: 'agent-skill-binding:one',
        appId: 'app:one',
        agentId: 'agent:one',
        skillId: 'skill:one',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  );
  const inventoryResponse = response();

  await handleBrowserSkillRoutes(
    request('GET'),
    inventoryResponse,
    routeContext() as never,
    '/ui/api/skills',
    settings,
  );

  const inventory = BrowserSkillInventoryResponseSchema.parse(
    JSON.parse(inventoryResponse.body),
  );
  expect(inventoryResponse.statusCode).toBe(200);
  expect(inventory.skills[0]).toMatchObject({
    id: 'skill:one',
    attachedAgents: [{ id: 'agent:one', status: 'active' }],
  });
  expect(inventory.skills[0]?.actions[0]).toMatchObject({
    capabilityId: 'skill.safe.read',
    requiredCredentialNames: ['PRIVATE_ACCESS_TOKEN'],
  });
  expect(inventoryResponse.body).not.toMatch(
    /private\/storage\/ref|private-hash|super-secret-value|credentialValues|commandTemplates|createdBy|promptRefs/,
  );

  const installResponse = response();
  await handleBrowserSkillRoutes(
    request('POST', Buffer.from('not-used'), {
      'content-type': 'application/zip',
      origin: settings.authentication.canonicalOrigin,
    }),
    installResponse,
    routeContext() as never,
    '/ui/api/skills/install',
    settings,
  );
  expect(installResponse.statusCode).toBe(403);

  const attachmentResponse = response();
  await handleBrowserSkillRoutes(
    request('PUT', Buffer.from(JSON.stringify({ agentIds: ['agent:one'] })), {
      origin: settings.authentication.canonicalOrigin,
    }),
    attachmentResponse,
    routeContext() as never,
    '/ui/api/skills/skill%3Aone/agents',
    settings,
  );
  expect(attachmentResponse.statusCode).toBe(403);
  expect(storage.skillArtifacts.putSkillArtifact).not.toHaveBeenCalled();
  expect(
    storage.repositories.skills.replaceSkillAgentBindings,
  ).not.toHaveBeenCalled();
});

it('saves one complete attachment set and projects settings once after commit', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:admin',
    role: 'administrator',
    csrfHash: 'csrf-hash',
    reauthenticatedAt: new Date().toISOString(),
  });
  const bindings = [
    {
      id: 'binding:one',
      appId: 'app:one',
      agentId: 'agent:one',
      skillId: 'skill:one',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'binding:disabled',
      appId: 'app:one',
      agentId: 'agent:disabled',
      skillId: 'skill:one',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  storage.repositories.skills.replaceSkillAgentBindings.mockResolvedValue(
    bindings,
  );
  storage.repositories.skills.getSkill.mockResolvedValue({
    id: 'skill:one',
    appId: 'app:one',
    status: 'installed',
  });
  storage.repositories.agents.listAgents.mockResolvedValue([
    {
      id: 'agent:one',
      name: 'Agent One',
      status: 'active',
      appId: 'app:one',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'agent:disabled',
      name: 'Agent Disabled',
      status: 'disabled',
      appId: 'app:one',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  const ctx = routeContext();
  const res = response();

  await handleBrowserSkillRoutes(
    request(
      'PUT',
      Buffer.from(
        JSON.stringify({ agentIds: ['agent:one', 'agent:disabled'] }),
      ),
      { origin: settings.authentication.canonicalOrigin },
    ),
    res,
    ctx as never,
    '/ui/api/skills/skill%3Aone/agents',
    settings,
  );

  expect(res.statusCode).toBe(200);
  expect(
    storage.repositories.skills.replaceSkillAgentBindings,
  ).toHaveBeenCalledOnce();
  expect(ctx.syncSettingsFromProjection).toHaveBeenCalledOnce();
  expect(
    storage.repositories.skills.replaceSkillAgentBindings.mock
      .invocationCallOrder[0],
  ).toBeLessThan(ctx.syncSettingsFromProjection.mock.invocationCallOrder[0]!);
  expect(requireBrowserMutationSession).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'hosted', originIsValid: true }),
  );
  expect(
    BrowserSkillAttachmentsResponseSchema.parse(JSON.parse(res.body)).agents,
  ).toEqual([
    expect.objectContaining({ id: 'agent:one', attached: true }),
    expect.objectContaining({
      id: 'agent:disabled',
      status: 'disabled',
      attached: true,
    }),
  ]);
});

it('installs a validated ZIP into inventory without attaching agents', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:admin',
    role: 'administrator',
    reauthenticatedAt: new Date().toISOString(),
  });
  parseSkillZipUpload.mockReturnValue({
    fallbackName: 'uploaded-skill',
    assets: [
      {
        path: 'SKILL.md',
        content: Buffer.from('---\nname: Browser Skill\n---\n# Browser Skill'),
      },
    ],
  });
  storage.repositories.skills.listSkills.mockResolvedValue([]);
  storage.skillArtifacts.putSkillArtifact.mockResolvedValue({
    storageType: 'object-store',
    storageRef: 'private/storage/ref',
    contentHash: 'sha256:private-hash',
    sizeBytes: 42,
  });
  storage.repositories.agents.listAgents.mockResolvedValue([]);
  storage.repositories.skills.listAgentSkillBindingsForAgents.mockResolvedValue(
    [],
  );
  const ctx = routeContext();
  const res = response();

  await handleBrowserSkillRoutes(
    request('POST', Buffer.from('validated-zip'), {
      'content-type': 'application/zip',
      origin: settings.authentication.canonicalOrigin,
    }),
    res,
    ctx as never,
    '/ui/api/skills/install',
    settings,
  );

  expect(res.statusCode).toBe(201);
  expect(
    BrowserInstallSkillResponseSchema.parse(JSON.parse(res.body)).skill,
  ).toMatchObject({ name: 'Browser Skill', attachedAgents: [] });
  expect(storage.repositories.skills.saveSkill).toHaveBeenCalledOnce();
  expect(
    storage.repositories.skills.replaceSkillAgentBindings,
  ).not.toHaveBeenCalled();
  expect(ctx.syncSettingsFromProjection).not.toHaveBeenCalled();
});

it('sanitizes operational skill-install failures as server errors', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:admin',
    role: 'administrator',
    reauthenticatedAt: new Date().toISOString(),
  });
  parseSkillZipUpload.mockReturnValue({
    fallbackName: 'uploaded-skill',
    assets: [{ path: 'SKILL.md', content: Buffer.from('# Browser Skill') }],
  });
  storage.repositories.skills.listSkills.mockResolvedValue([]);
  storage.skillArtifacts.putSkillArtifact.mockRejectedValue(
    new Error('private object-store credentials failed'),
  );
  const res = response();

  await handleBrowserSkillRoutes(
    request('POST', Buffer.from('validated-zip'), {
      'content-type': 'application/zip',
      origin: settings.authentication.canonicalOrigin,
    }),
    res,
    routeContext() as never,
    '/ui/api/skills/install',
    settings,
  );

  expect(res.statusCode).toBe(500);
  expect(res.body).toContain('SKILL_INSTALL_FAILED');
  expect(res.body).not.toContain('private object-store credentials');
});

it('projects settings after updating an attached skill', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:admin',
    role: 'administrator',
    reauthenticatedAt: new Date().toISOString(),
  });
  parseSkillZipUpload.mockReturnValue({
    fallbackName: 'browser-skill',
    assets: [
      {
        path: 'SKILL.md',
        content: Buffer.from('---\nname: Browser Skill\n---\n# Updated'),
      },
    ],
  });
  storage.repositories.skills.listSkills.mockResolvedValue([
    {
      id: 'skill:existing',
      appId: 'app:one',
      name: 'Browser Skill',
      source: 'admin_uploaded',
      status: 'installed',
      promptRefs: [],
      toolIds: [],
      workflowRefs: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  storage.skillArtifacts.putSkillArtifact.mockResolvedValue({
    storageType: 'object-store',
    storageRef: 'private/storage/updated',
    contentHash: 'sha256:updated',
    sizeBytes: 42,
  });
  storage.repositories.agents.listAgents.mockResolvedValue([
    {
      id: 'agent:one',
      appId: 'app:one',
      name: 'Agent One',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ]);
  storage.repositories.skills.listAgentSkillBindingsForAgents.mockResolvedValue(
    [
      {
        id: 'binding:existing',
        appId: 'app:one',
        agentId: 'agent:one',
        skillId: 'skill:existing',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  );
  const ctx = routeContext();
  const res = response();

  await handleBrowserSkillRoutes(
    request('POST', Buffer.from('validated-zip'), {
      'content-type': 'application/zip',
      origin: settings.authentication.canonicalOrigin,
    }),
    res,
    ctx as never,
    '/ui/api/skills/install',
    settings,
  );

  expect(res.statusCode).toBe(201);
  expect(ctx.syncSettingsFromProjection).toHaveBeenCalledOnce();
  expect(ctx.syncSettingsFromProjection).toHaveBeenCalledWith('app:one');
});

it('requires a session and recent hosted reauthentication', async () => {
  activeSession.mockResolvedValue(null);
  const readResponse = response();
  await handleBrowserSkillRoutes(
    request('GET'),
    readResponse,
    routeContext() as never,
    '/ui/api/skills',
    settings,
  );
  expect(readResponse.statusCode).toBe(401);

  requireBrowserMutationSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:admin',
    role: 'administrator',
    reauthenticatedAt: '2020-01-01T00:00:00.000Z',
  });
  const mutationResponse = response();
  await handleBrowserSkillRoutes(
    request('PUT', Buffer.from(JSON.stringify({ agentIds: [] })), {
      origin: settings.authentication.canonicalOrigin,
    }),
    mutationResponse,
    routeContext() as never,
    '/ui/api/skills/skill%3Aone/agents',
    settings,
  );
  expect(mutationResponse.statusCode).toBe(401);
  expect(
    storage.repositories.skills.replaceSkillAgentBindings,
  ).not.toHaveBeenCalled();
});

it('rejects cross-app attachment ids before mutation', async () => {
  requireBrowserMutationSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:admin',
    role: 'administrator',
    reauthenticatedAt: new Date().toISOString(),
  });
  storage.repositories.skills.getSkill.mockResolvedValue({
    id: 'skill:one',
    appId: 'app:one',
    status: 'installed',
  });
  storage.repositories.agents.listAgents.mockResolvedValue([]);
  const res = response();

  await handleBrowserSkillRoutes(
    request(
      'PUT',
      Buffer.from(JSON.stringify({ agentIds: ['agent:other-app'] })),
      { origin: settings.authentication.canonicalOrigin },
    ),
    res,
    routeContext() as never,
    '/ui/api/skills/skill%3Aone/agents',
    settings,
  );

  expect(res.statusCode).toBe(404);
  expect(res.body).not.toContain('agent:other-app');
  expect(
    storage.repositories.skills.replaceSkillAgentBindings,
  ).not.toHaveBeenCalled();
});

it('returns only verified app-scoped file bytes and sanitizes failures', async () => {
  activeSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:viewer',
    role: 'viewer',
  });
  const bundle = {
    assets: [
      { path: 'SKILL.md', content: Buffer.from('# Safe skill') },
      { path: 'asset.bin', content: Buffer.from([0xff, 0xfe, 0xfd]) },
      { path: 'control.bin', content: Buffer.from([0x00, 0x01, 0x02]) },
    ],
  };
  storage.repositories.skills.getSkill.mockResolvedValue({
    id: 'skill:one',
    appId: 'app:one',
    name: 'Safe Skill',
    source: 'admin_uploaded',
    status: 'installed',
    promptRefs: [],
    toolIds: [],
    workflowRefs: [],
    storage: {
      storageType: 'object-store',
      storageRef: 'private/storage/ref',
      contentHash: hashSkillBundle(bundle),
      sizeBytes: 15,
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  storage.skillArtifacts.getSkillArtifact.mockResolvedValue(bundle);
  const binaryResponse = response();

  await handleBrowserSkillRoutes(
    request('GET'),
    binaryResponse,
    routeContext() as never,
    '/ui/api/skills/skill%3Aone/files/asset.bin',
    settings,
  );

  expect(binaryResponse.statusCode).toBe(200);
  expect(
    BrowserSkillFileResponseSchema.parse(JSON.parse(binaryResponse.body)).file,
  ).toEqual({
    path: 'asset.bin',
    contentType: null,
    sizeBytes: 3,
    isText: false,
    content: null,
  });

  const controlResponse = response();
  await handleBrowserSkillRoutes(
    request('GET'),
    controlResponse,
    routeContext() as never,
    '/ui/api/skills/skill%3Aone/files/control.bin',
    settings,
  );
  expect(controlResponse.statusCode).toBe(200);
  expect(
    BrowserSkillFileResponseSchema.parse(JSON.parse(controlResponse.body)).file,
  ).toMatchObject({ path: 'control.bin', isText: false, content: null });

  storage.skillArtifacts.getSkillArtifact.mockResolvedValue({
    assets: [{ path: 'SKILL.md', content: Buffer.from('tampered') }],
  });
  const integrityResponse = response();
  await handleBrowserSkillRoutes(
    request('GET'),
    integrityResponse,
    routeContext() as never,
    '/ui/api/skills/skill%3Aone/files',
    settings,
  );
  expect(integrityResponse.statusCode).toBe(500);
  expect(integrityResponse.body).toContain('SKILL_FILES_UNAVAILABLE');
  expect(integrityResponse.body).not.toMatch(
    /private\/storage\/ref|sha256:|tampered|expected|got/,
  );

  storage.repositories.skills.getSkill.mockResolvedValue({
    id: 'skill:foreign',
    appId: 'app:other',
    storage: { storageRef: 'other-app/private-ref' },
  });
  const crossAppResponse = response();
  await handleBrowserSkillRoutes(
    request('GET'),
    crossAppResponse,
    routeContext() as never,
    '/ui/api/skills/skill%3Aforeign/files',
    settings,
  );
  expect(crossAppResponse.statusCode).toBe(404);
});

it('lists bundled skills without an artifact as an empty file collection', async () => {
  activeSession.mockResolvedValue({
    appId: 'app:one',
    userId: 'user:viewer',
    role: 'viewer',
  });
  storage.repositories.skills.getSkill.mockResolvedValue({
    id: 'skill:memory',
    appId: 'app:one',
    name: 'memory',
    source: 'bundled',
    status: 'installed',
  });
  const res = response();

  await handleBrowserSkillRoutes(
    request('GET'),
    res,
    routeContext() as never,
    '/ui/api/skills/skill%3Amemory/files',
    settings,
  );

  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ skillId: 'skill:memory', files: [] });
  expect(storage.skillArtifacts.getSkillArtifact).not.toHaveBeenCalled();
});
