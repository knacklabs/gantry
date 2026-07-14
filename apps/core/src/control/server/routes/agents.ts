import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  CreateAgentRequestSchema,
  PutAgentProfileFileRequestSchema,
  UpdateAgentRequestSchema,
} from '@gantry/contracts';

import { ApplicationError } from '../../../application/common/application-error.js';
import { AgentCapabilityAdministrationService } from '../../../application/agents/agent-capability-administration-service.js';
import {
  AgentProfileService,
  MAX_PROFILE_CONTENT_BYTES,
  ProfileContentTooLargeError,
  ProfileVersionConflictError,
  isProfileFileKind,
} from '../../../application/agents/agent-profile-service.js';
import { PROFILE_FILE_NAMES } from '../../../application/agents/prompt-profile-service.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  getRuntimeFileArtifactStore,
  getRuntimeStorage,
} from '../../../adapters/storage/postgres/runtime-store.js';
import { FileArtifactNotFoundError } from '../../../domain/file-artifacts/file-artifact.js';
import { folderForAgentId } from '../../../domain/agent/agent-folder-id.js';
import { isValidWorkspaceFolder } from '../../../platform/workspace-folder.js';
import { createProfileFileMirrorWriter } from '../../../platform/profile-file-mirror.js';
import { RUNTIME_EVENT_TYPES } from '../../../domain/events/runtime-event-types.js';
import type { Agent, AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ConversationInstall } from '../../../domain/provider/provider.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { nowIso } from '../../../shared/time/datetime.js';
import {
  loadRuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../../../config/settings/runtime-settings.js';

const PROFILE_JSON_BODY_MAX_BYTES = MAX_PROFILE_CONTENT_BYTES * 6 + 64 * 1024;

function buildAgentProfileService(
  actorAgentId: AgentId,
  appId: AppId,
  runtimeHome: string,
): AgentProfileService {
  const storage = getRuntimeStorage();
  return new AgentProfileService({
    appId,
    fileArtifactStore: () => getRuntimeFileArtifactStore(),
    mirrorProfileFile: createProfileFileMirrorWriter(runtimeHome),
    onSideEffectError: (input) => {
      logger.warn(
        {
          err: input.error,
          agentId: actorAgentId,
          sideEffect: input.sideEffect,
          fileKind: input.kind,
          version: input.version,
        },
        'Profile update side effect failed after durable write',
      );
    },
    audit: (input) =>
      // Audit is best-effort but must not be silently dropped: a failed publish
      // is logged instead of becoming an unhandled rejection, and it never fails
      // the profile read/write itself.
      storage.runtimeEvents
        .publish({
          appId,
          agentId: actorAgentId,
          eventType:
            input.action === 'update'
              ? RUNTIME_EVENT_TYPES.PROFILE_FILE_UPDATED
              : RUNTIME_EVENT_TYPES.PROFILE_FILE_READ,
          actor: input.actor,
          payload: {
            fileKind: input.kind,
            version: input.version,
            contentHash: input.contentHash,
            actor: input.actor,
            ...(input.approvalSource
              ? { approvalSource: input.approvalSource }
              : {}),
          },
        })
        .then(() => undefined)
        .catch((err) => {
          logger.warn(
            { err, agentId: actorAgentId, action: input.action },
            'Failed to publish profile audit event',
          );
        }),
  });
}

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ApplicationError)) return false;
  switch (error.code) {
    case 'NOT_FOUND':
      sendError(res, 404, 'NOT_FOUND', error.message);
      return true;
    case 'FORBIDDEN':
      sendError(res, 403, 'FORBIDDEN', error.message);
      return true;
    case 'INVALID_REQUEST':
      sendError(res, 400, 'INVALID_REQUEST', error.message);
      return true;
    default:
      return false;
  }
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/agents' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agents = await getRuntimeStorage().repositories.agents.listAgents(
      auth.appId as AppId,
    );
    sendJson(res, 200, {
      agents: agents.map((agent) => agentToResponse(ctx, agent)),
    });
    return true;
  }

  if (pathname === '/v1/agents' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = CreateAgentRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent');
      return true;
    }
    if (parsed.data.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot create agent for app');
      return true;
    }
    const now = nowIso();
    const folder = randomUUID();
    const agent: Agent = {
      id: `agent:${folder}` as AgentId,
      appId: auth.appId as AppId,
      name: parsed.data.name.trim(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await getRuntimeStorage().repositories.agents.saveAgent(agent);
    let settingsWritten = false;
    if (parsed.data.agentHarness) {
      await writeAgentHarnessSetting(
        ctx.runtimeHome,
        auth.appId as AppId,
        folder,
        {
          name: agent.name,
          agentHarness: parsed.data.agentHarness,
        },
      );
      settingsWritten = true;
    }
    if (!settingsWritten)
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
    sendJson(res, 201, agentToResponse(ctx, agent));
    return true;
  }

  const agentAdminMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/admin$/);
  if (agentAdminMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agentId = decodeURIComponent(agentAdminMatch[1]) as AgentId;
    const agent =
      await getRuntimeStorage().repositories.agents.getAgent(agentId);
    if (!agent || agent.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return true;
    }
    try {
      const boundConversations = await agentBoundConversations({
        appId: auth.appId as AppId,
        agentId,
      });
      const repositories = getRuntimeStorage().repositories;
      const capabilitiesView =
        repositories.tools && repositories.skills && repositories.mcpServers
          ? await new AgentCapabilityAdministrationService({
              agents: repositories.agents,
              tools: repositories.tools,
              skills: repositories.skills,
              mcpServers: repositories.mcpServers,
            }).getCapabilities({
              appId: auth.appId as AppId,
              agentId,
            })
          : undefined;
      // The /admin response contract (AgentCapabilitiesResponseSchema, strict)
      // does not carry the access summary; that lives on the /access endpoint.
      const capabilities = capabilitiesView
        ? (({ summary: _summary, ...rest }) => rest)(capabilitiesView)
        : undefined;
      sendJson(res, 200, {
        agent: agentToResponse(ctx, agent),
        capabilities,
        boundConversations,
      });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  const profileListMatch = pathname.match(
    /^\/v1\/agents\/([^/]+)\/profile-files$/,
  );
  if (profileListMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agentId = decodeURIComponent(profileListMatch[1]) as AgentId;
    const folder = await resolveProfileAgentFolder(
      res,
      auth.appId as AppId,
      agentId,
    );
    if (!folder) return true;
    const files = await buildAgentProfileService(
      agentId,
      auth.appId as AppId,
      ctx.runtimeHome,
    ).listProfileFiles(folder);
    sendJson(res, 200, { agentId, files });
    return true;
  }

  const profileKindMatch = pathname.match(
    /^\/v1\/agents\/([^/]+)\/profile-files\/([^/]+)$/,
  );
  if (profileKindMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agentId = decodeURIComponent(profileKindMatch[1]) as AgentId;
    const kind = decodeURIComponent(profileKindMatch[2]);
    if (!isProfileFileKind(kind)) {
      sendError(res, 400, 'INVALID_REQUEST', 'Unknown profile file kind');
      return true;
    }
    const folder = await resolveProfileAgentFolder(
      res,
      auth.appId as AppId,
      agentId,
    );
    if (!folder) return true;
    try {
      const file = await buildAgentProfileService(
        agentId,
        auth.appId as AppId,
        ctx.runtimeHome,
      ).readProfileFile(folder, kind, { actor: 'control' });
      sendJson(res, 200, { agentId, ...file });
    } catch (error) {
      if (error instanceof FileArtifactNotFoundError) {
        sendError(res, 404, 'NOT_FOUND', 'Profile file not found');
        return true;
      }
      throw error;
    }
    return true;
  }

  if (profileKindMatch && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agentId = decodeURIComponent(profileKindMatch[1]) as AgentId;
    const kind = decodeURIComponent(profileKindMatch[2]);
    if (!isProfileFileKind(kind)) {
      sendError(res, 400, 'INVALID_REQUEST', 'Unknown profile file kind');
      return true;
    }
    const parsed = PutAgentProfileFileRequestSchema.safeParse(
      await readJson(req, PROFILE_JSON_BODY_MAX_BYTES),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid profile file update');
      return true;
    }
    const folder = await resolveProfileAgentFolder(
      res,
      auth.appId as AppId,
      agentId,
    );
    if (!folder) return true;
    try {
      const result = await buildAgentProfileService(
        agentId,
        auth.appId as AppId,
        ctx.runtimeHome,
      ).writeProfileFile({
        agentFolder: folder,
        kind,
        content: parsed.data.content,
        expectedVersion: parsed.data.expectedVersion,
        actor: 'control',
        approvalSource: 'control_api',
      });
      sendJson(res, 200, {
        agentId,
        kind,
        path: PROFILE_FILE_NAMES[kind],
        version: result.version,
        contentHash: result.contentHash,
        content: parsed.data.content,
      });
    } catch (error) {
      if (error instanceof ProfileVersionConflictError) {
        sendError(
          res,
          409,
          'CONFLICT',
          `${error.message} Latest version is ${error.latestVersion}.`,
        );
        return true;
      }
      if (error instanceof ProfileContentTooLargeError) {
        sendError(res, 413, 'PAYLOAD_TOO_LARGE', error.message);
        return true;
      }
      throw error;
    }
    return true;
  }

  const agentMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (agentMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const agent = await getRuntimeStorage().repositories.agents.getAgent(
      decodeURIComponent(agentMatch[1]) as AgentId,
    );
    if (!agent || agent.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return true;
    }
    sendJson(res, 200, agentToResponse(ctx, agent));
    return true;
  }

  const patchMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
  if (patchMatch && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = UpdateAgentRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent update');
      return true;
    }
    const repository = getRuntimeStorage().repositories.agents;
    const agent = await repository.getAgent(
      decodeURIComponent(patchMatch[1]) as AgentId,
    );
    if (!agent || agent.appId !== auth.appId) {
      sendError(res, 404, 'NOT_FOUND', 'Agent not found');
      return true;
    }
    const updated: Agent = {
      ...agent,
      name: parsed.data.name?.trim() ?? agent.name,
      status: parsed.data.status ?? agent.status,
      updatedAt: nowIso(),
    };
    if (parsed.data.agentHarness && updated.status !== 'active') {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'agentHarness can only be updated for active agents.',
      );
      return true;
    }
    await repository.saveAgent(updated);
    let settingsWritten = false;
    if (parsed.data.agentHarness && updated.status === 'active') {
      const folder = folderForAgentId(updated.id);
      if (folder) {
        await writeAgentHarnessSetting(
          ctx.runtimeHome,
          auth.appId as AppId,
          folder,
          {
            name: updated.name,
            agentHarness: parsed.data.agentHarness,
          },
        );
        settingsWritten = true;
      }
    }
    if (!settingsWritten)
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
    sendJson(res, 200, agentToResponse(ctx, updated));
    return true;
  }

  return false;
}

async function resolveProfileAgentFolder(
  res: ServerResponse,
  appId: AppId,
  agentId: AgentId,
): Promise<string | null> {
  const agent = await getRuntimeStorage().repositories.agents.getAgent(agentId);
  if (!agent || agent.appId !== appId) {
    sendError(res, 404, 'NOT_FOUND', 'Agent not found');
    return null;
  }
  const folder = folderForAgentId(agentId);
  if (!folder || !isValidWorkspaceFolder(folder)) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Agent does not have profile files (no workspace folder).',
    );
    return null;
  }
  return folder;
}

function agentToResponse(ctx: ControlRouteContext, agent: Agent) {
  const folder = folderForAgentId(agent.id) ?? undefined;
  return {
    id: agent.id,
    appId: agent.appId,
    name: agent.name,
    status: agent.status,
    agentHarness: ctx.getSelectedAgentHarness(folder),
    currentConfigVersionId: agent.currentConfigVersionId,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

async function writeAgentHarnessSetting(
  runtimeHome: string,
  appId: AppId,
  folder: string,
  input: {
    name: string;
    agentHarness: 'auto' | 'anthropic_sdk' | 'deepagents';
  },
): Promise<void> {
  const settings = loadRuntimeSettings(runtimeHome);
  const previousSettings = structuredClone(settings);
  const existing = settings.agents[folder];
  settings.agents[folder] = {
    ...existing,
    name: input.name,
    folder,
    bindings: existing?.bindings ?? {},
    sources: existing?.sources ?? { skills: [], mcpServers: [], tools: [] },
    capabilities: existing?.capabilities ?? [],
    accessPreset: existing?.accessPreset ?? 'full',
    agentHarness: input.agentHarness,
  };
  await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
    appId,
    createdBy: 'control-api:agent-harness',
  });
}

async function agentBoundConversations(input: {
  appId: AppId;
  agentId: AgentId;
}): Promise<
  Array<{
    conversationId: string;
    provider: string;
    kind: string;
    displayName?: string;
    approverUserIds: string[];
    requiresTrigger: boolean;
    trigger?: string;
  }>
> {
  const repositories = getRuntimeStorage().repositories;
  const bindings = await repositories.providerAccounts.listConversationInstalls(
    input.appId,
    input.agentId,
  );
  const activeBindings = bindings
    .filter((binding) => binding.status === 'active')
    .sort((a, b) =>
      String(a.conversationId).localeCompare(String(b.conversationId)),
    );
  const summaries = await Promise.all(
    activeBindings.map(async (binding) =>
      agentBoundConversation(input.appId, binding),
    ),
  );
  return summaries.filter(
    (summary): summary is NonNullable<typeof summary> => summary !== null,
  );
}

async function agentBoundConversation(
  appId: AppId,
  binding: ConversationInstall,
): Promise<{
  conversationId: string;
  provider: string;
  kind: string;
  displayName?: string;
  approverUserIds: string[];
  requiresTrigger: boolean;
  trigger?: string;
} | null> {
  const repositories = getRuntimeStorage().repositories;
  const conversation = await repositories.conversations.getConversation(
    binding.conversationId,
  );
  if (!conversation || conversation.appId !== appId) return null;
  const providerConnection =
    await repositories.providerAccounts.getProviderAccount(
      conversation.providerAccountId,
    );
  if (!providerConnection || providerConnection.appId !== appId) return null;
  const approvers = await repositories.conversations.listConversationApprovers(
    conversation.id,
  );
  const route =
    binding.memorySubject &&
    typeof binding.memorySubject === 'object' &&
    'route' in binding.memorySubject &&
    binding.memorySubject.route &&
    typeof binding.memorySubject.route === 'object'
      ? (binding.memorySubject.route as {
          requiresTrigger?: unknown;
          trigger?: unknown;
        })
      : undefined;
  return {
    conversationId: conversation.id,
    provider: providerConnection.providerId,
    kind: conversation.kind,
    ...(conversation.title ? { displayName: conversation.title } : {}),
    approverUserIds: approvers.map((approver) => approver.externalUserId),
    requiresTrigger:
      typeof route?.requiresTrigger === 'boolean'
        ? route.requiresTrigger
        : conversation.kind !== 'direct',
    ...(typeof route?.trigger === 'string' && route.trigger
      ? { trigger: route.trigger }
      : {}),
  };
}
