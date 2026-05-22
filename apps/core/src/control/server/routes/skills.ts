import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import {
  ApproveSkillDraftRequestSchema,
  RejectSkillDraftRequestSchema,
  UpdateAgentSkillBindingRequestSchema,
  UploadSkillDraftContextSchema,
} from '@gantry/contracts';

import { SkillDraftService } from '../../../application/skills/skill-draft-service.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  AgentSkillBinding,
  SkillCatalogItem,
  SkillId,
} from '../../../domain/skills/skills.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, readRawBody, sendError, sendJson } from '../http.js';
import {
  MAX_SKILL_ZIP_BYTES,
  parseSkillZipUpload,
} from '../skill-zip-upload.js';

function service(): SkillDraftService {
  const storage = getRuntimeStorage();
  return new SkillDraftService(
    storage.repositories.skills,
    storage.skillArtifacts,
  );
}

export async function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  url: URL,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/skills/drafts' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:read']);
    if (!auth) return true;
    const agentId = url.searchParams.get('agentId') || undefined;
    const drafts = await service().listDrafts({
      appId: auth.appId as AppId,
      agentId: agentId as AgentId | undefined,
    });
    sendJson(res, 200, { drafts: drafts.map(skillToResponse) });
    return true;
  }

  if (pathname === '/v1/skills/drafts/upload' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:admin']);
    if (!auth) return true;
    const contentType = String(req.headers['content-type'] || '').split(';')[0];
    if (contentType !== 'application/zip') {
      sendError(
        res,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Skill draft upload requires application/zip',
      );
      return true;
    }
    const parsed = UploadSkillDraftContextSchema.safeParse({
      appId: url.searchParams.get('appId') || undefined,
      agentId: url.searchParams.get('agentId') || undefined,
      createdBy: url.searchParams.get('createdBy') || undefined,
    });
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid skill draft upload');
      return true;
    }
    if (parsed.data.appId && parsed.data.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot upload for this app');
      return true;
    }
    try {
      if (parsed.data.agentId) {
        await requireAgentInApp({
          appId: auth.appId as AppId,
          agentId: parsed.data.agentId as AgentId,
        });
      }
      const zip = await readRawBody(req, MAX_SKILL_ZIP_BYTES);
      const uploaded = parseSkillZipUpload(zip);
      const draft = await service().importDraft({
        appId: auth.appId as AppId,
        agentId: parsed.data.agentId as AgentId | undefined,
        createdBy: parsed.data.createdBy,
        fallbackName: uploaded.fallbackName,
        assets: uploaded.assets,
      });
      sendJson(res, 201, { draft: skillToResponse(draft) });
    } catch (error) {
      sendError(
        res,
        error instanceof Error && error.message === 'Payload too large'
          ? 413
          : 400,
        'INVALID_REQUEST',
        error instanceof Error ? error.message : 'Invalid skill draft',
      );
    }
    return true;
  }

  const approveMatch = pathname.match(
    /^\/v1\/skills\/drafts\/([^/]+)\/approve$/,
  );
  if (approveMatch && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:admin']);
    if (!auth) return true;
    const parsed = ApproveSkillDraftRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid skill draft approval');
      return true;
    }
    if (parsed.data.appId && parsed.data.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot approve for this app');
      return true;
    }
    try {
      const skill = await service().approveDraft({
        appId: auth.appId as AppId,
        skillId: decodeURIComponent(approveMatch[1]) as SkillId,
        approvedBy: parsed.data.approvedBy,
      });
      sendJson(res, 200, { skill: skillToResponse(skill) });
    } catch (error) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        error instanceof Error ? error.message : 'Skill approval failed',
      );
    }
    return true;
  }

  const rejectMatch = pathname.match(/^\/v1\/skills\/drafts\/([^/]+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:admin']);
    if (!auth) return true;
    const parsed = RejectSkillDraftRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid skill draft rejection');
      return true;
    }
    if (parsed.data.appId && parsed.data.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot reject for this app');
      return true;
    }
    try {
      const skill = await service().rejectDraft({
        appId: auth.appId as AppId,
        skillId: decodeURIComponent(rejectMatch[1]) as SkillId,
        rejectedBy: parsed.data.rejectedBy,
      });
      sendJson(res, 200, { skill: skillToResponse(skill) });
    } catch (error) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        error instanceof Error ? error.message : 'Skill rejection failed',
      );
    }
    return true;
  }

  const skillFilesMatch = pathname.match(
    /^\/v1\/skills\/([^/]+)\/files(?:\/(.+))?$/,
  );
  if (skillFilesMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:read']);
    if (!auth) return true;
    try {
      const runtime = getRuntimeStorage();
      const skill = await new SkillDraftService(
        runtime.repositories.skills,
        runtime.skillArtifacts,
      ).requireSkill(
        auth.appId as AppId,
        decodeURIComponent(skillFilesMatch[1]) as SkillId,
      );
      if (!skill.storage) {
        sendError(
          res,
          404,
          'NOT_FOUND',
          'Skill does not have readable local files',
        );
        return true;
      }
      const bundle = await runtime.skillArtifacts.getSkillArtifact(
        skill.storage.storageRef,
      );
      const requestedPath = skillFilesMatch[2]
        ? normalizeRequestedSkillFilePath(
            decodeURIComponent(skillFilesMatch[2]),
          )
        : undefined;
      if (!requestedPath) {
        sendJson(res, 200, {
          skill: skillToResponse(skill),
          files: bundle.assets.map(skillAssetToFileResponse),
        });
        return true;
      }
      const asset = bundle.assets.find((item) => item.path === requestedPath);
      if (!asset) {
        sendError(res, 404, 'NOT_FOUND', 'Skill file not found');
        return true;
      }
      sendJson(res, 200, {
        file: {
          ...skillAssetToFileResponse(asset),
          ...skillAssetContentResponse(asset),
        },
      });
    } catch (error) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        error instanceof Error ? error.message : 'Skill file lookup failed',
      );
    }
    return true;
  }

  const agentSkillMatch = pathname.match(
    /^\/v1\/agents\/([^/]+)\/skills\/([^/]+)$/,
  );
  if (agentSkillMatch && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:admin']);
    if (!auth) return true;
    const parsed = UpdateAgentSkillBindingRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent skill binding');
      return true;
    }
    if (parsed.data.appId && parsed.data.appId !== auth.appId) {
      sendError(res, 403, 'FORBIDDEN', 'API key cannot bind for this app');
      return true;
    }
    const appId = auth.appId as AppId;
    const agentId = decodeURIComponent(agentSkillMatch[1]) as AgentId;
    const skillId = decodeURIComponent(agentSkillMatch[2]) as SkillId;
    const skillService = service();
    let binding: AgentSkillBinding | undefined;
    try {
      await requireAgentInApp({
        appId,
        agentId,
      });
      binding = await skillService.bindSkillToAgent({
        appId,
        agentId,
        skillId,
      });
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, { binding: bindingToResponse(binding) });
    } catch (error) {
      if (binding) {
        await skillService
          .unbindSkillFromAgent({
            appId,
            agentId,
            skillId,
          })
          .catch(() => undefined);
      }
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        error instanceof Error ? error.message : 'Skill binding failed',
      );
    }
    return true;
  }

  if (agentSkillMatch && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:admin']);
    if (!auth) return true;
    try {
      await requireAgentInApp({
        appId: auth.appId as AppId,
        agentId: decodeURIComponent(agentSkillMatch[1]) as AgentId,
      });
      const binding = await service().unbindSkillFromAgent({
        appId: auth.appId as AppId,
        agentId: decodeURIComponent(agentSkillMatch[1]) as AgentId,
        skillId: decodeURIComponent(agentSkillMatch[2]) as SkillId,
      });
      await ctx.syncSettingsFromProjection(auth.appId as AppId);
      sendJson(res, 200, {
        disabled: Boolean(binding),
        binding: binding ? bindingToResponse(binding) : null,
      });
    } catch (error) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        error instanceof Error ? error.message : 'Skill unbinding failed',
      );
    }
    return true;
  }

  const agentSkillsMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/skills$/);
  if (agentSkillsMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['skills:read']);
    if (!auth) return true;
    try {
      await requireAgentInApp({
        appId: auth.appId as AppId,
        agentId: decodeURIComponent(agentSkillsMatch[1]) as AgentId,
      });
    } catch (error) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        error instanceof Error ? error.message : 'Agent skill lookup failed',
      );
      return true;
    }
    const bindings =
      await getRuntimeStorage().repositories.skills.listAgentSkillBindings({
        appId: auth.appId as AppId,
        agentId: decodeURIComponent(agentSkillsMatch[1]) as AgentId,
      });
    sendJson(res, 200, { bindings: bindings.map(bindingToResponse) });
    return true;
  }

  return false;
}

function skillAssetContentResponse(asset: {
  contentType?: string;
  content: Uint8Array;
}): { encoding: 'utf-8' | 'base64'; content: string } {
  const content = Buffer.from(asset.content);
  const contentType = asset.contentType ?? '';
  const textLike =
    contentType.startsWith('text/') ||
    [
      'application/json',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'image/svg+xml',
    ].includes(contentType);
  return textLike
    ? { encoding: 'utf-8', content: content.toString('utf-8') }
    : { encoding: 'base64', content: content.toString('base64') };
}

function skillToResponse(skill: SkillCatalogItem): Record<string, unknown> {
  return {
    id: skill.id,
    appId: skill.appId,
    agentId: skill.agentId,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source: skill.source,
    status: skill.status,
    promptRefs: skill.promptRefs,
    toolIds: skill.toolIds,
    workflowRefs: skill.workflowRefs,
    requiredEnvVars: skill.requiredEnvVars ?? [],
    actionPermissions: skill.actionPermissions ?? [],
    storage: skill.storage,
    createdBy: skill.createdBy,
    approvedBy: skill.approvedBy,
    approvedAt: skill.approvedAt,
    rejectedBy: skill.rejectedBy,
    rejectedAt: skill.rejectedAt,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

async function requireAgentInApp(input: {
  appId: AppId;
  agentId: AgentId;
}): Promise<void> {
  const agent = await getRuntimeStorage().repositories.agents.getAgent(
    input.agentId,
  );
  if (!agent || agent.appId !== input.appId) {
    throw new Error(`Agent not found: ${input.agentId}`);
  }
}

function bindingToResponse(
  binding: AgentSkillBinding,
): Record<string, unknown> {
  return {
    id: binding.id,
    appId: binding.appId,
    agentId: binding.agentId,
    skillId: binding.skillId,
    configVersionId: binding.configVersionId,
    status: binding.status,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function skillAssetToFileResponse(asset: {
  path: string;
  contentType?: string;
  content: Uint8Array;
}): Record<string, unknown> {
  const content = Buffer.from(asset.content);
  return {
    path: asset.path,
    contentType: asset.contentType,
    sizeBytes: content.byteLength,
    contentHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

function normalizeRequestedSkillFilePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    parts.some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid skill file path: ${value}`);
  }
  return parts.join('/');
}
