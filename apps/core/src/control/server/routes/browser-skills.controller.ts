import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  BrowserInstallSkillRequestSchema,
  ReplaceBrowserSkillAttachmentsRequestSchema,
} from '@gantry/contracts';

import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import {
  isRecentlyReauthenticated,
  type ConsoleRole,
} from '../../../application/auth/auth-foundations.js';
import { SkillService } from '../../../application/skills/skill-service.js';
import { readVerifiedSkillArtifact } from '../../../application/skills/selected-skill-projection.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  SkillCatalogItem,
  SkillId,
} from '../../../domain/skills/skills.js';
import { materializedSkillDirectoryNameFor } from '../../../domain/skills/skills.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import { readSkillFrontmatterName } from '../../../shared/skill-artifact-helpers.js';
import {
  skillMaterializationLockKey,
  withSkillMaterializationLock,
} from '../../../shared/skill-install-lock.js';
import { isCanonicalBrowserOrigin } from '../browser-auth-boundary.js';
import { browserRoleAllowsScope } from '../browser-scope-policy.js';
import type { ControlRouteContext } from '../handler-context.js';
import { readJson, readRawBody, sendError, sendJson } from '../http.js';
import {
  MAX_SKILL_ZIP_BYTES,
  parseSkillZipUpload,
} from '../skill-zip-upload.js';
import {
  browserSkillAttachmentAgents,
  browserSkillFile,
  browserSkillFileMetadata,
  browserSkillResponse,
} from './browser-skills.mapper.js';
import {
  activeSession,
  requireBrowserMutationSession,
} from './browser-auth.js';
import { normalizeRequestedSkillFilePath } from './skills.js';

type BrowserSkillSettings = {
  authentication: {
    mode: 'local' | 'hosted';
    canonicalOrigin: string;
  };
};

const BROWSER_SKILLS_PATH = '/ui/api/skills';
const BROWSER_SKILL_INSTALL_PATH = '/ui/api/skills/install';
const BROWSER_SKILL_FILES_PATH =
  /^\/ui\/api\/skills\/([^/]+)\/files(?:\/(.+))?$/;
const BROWSER_SKILL_AGENTS_PATH = /^\/ui\/api\/skills\/([^/]+)\/agents$/;

export function isBrowserSkillsPath(pathname: string): boolean {
  return (
    pathname === BROWSER_SKILLS_PATH || pathname.startsWith('/ui/api/skills/')
  );
}

function skillService(): SkillService {
  const storage = getRuntimeStorage();
  return new SkillService(storage.repositories.skills, storage.skillArtifacts);
}

export async function handleBrowserSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
  settings: BrowserSkillSettings,
): Promise<boolean> {
  if (!isBrowserSkillsPath(pathname)) return false;
  const mode = settings.authentication.mode;

  if (pathname === BROWSER_SKILLS_PATH && req.method === 'GET') {
    const session = await requireReadSession(req, res, mode);
    if (!session) return true;
    const storage = getRuntimeStorage();
    const appId = session.appId as AppId;
    const [skills, agents] = await Promise.all([
      skillService().listSkills({ appId }),
      storage.repositories.agents.listAgents(appId),
    ]);
    const bindings =
      await storage.repositories.skills.listAgentSkillBindingsForAgents({
        appId,
        agentIds: agents.map((agent) => agent.id),
      });
    sendJson(res, 200, {
      role: session.role,
      skills: skills.map((skill) =>
        browserSkillResponse(skill, agents, bindings),
      ),
    });
    return true;
  }

  if (pathname === BROWSER_SKILL_INSTALL_PATH && req.method === 'POST') {
    const session = await requireMutationSession(req, res, settings);
    if (!session) return true;
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0];
    if (contentType !== 'application/zip') {
      return browserError(
        res,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Choose a ZIP skill package.',
      );
    }
    let zip: Uint8Array;
    try {
      zip = await readRawBody(req, MAX_SKILL_ZIP_BYTES);
    } catch (error) {
      return (error as { code?: string }).code === 'PAYLOAD_TOO_LARGE'
        ? browserError(
            res,
            413,
            'PAYLOAD_TOO_LARGE',
            'The skill ZIP is too large.',
          )
        : browserError(
            res,
            400,
            'INVALID_REQUEST',
            'The skill ZIP could not be read.',
          );
    }
    const request = BrowserInstallSkillRequestSchema.safeParse(zip);
    if (!request.success) {
      return browserError(
        res,
        400,
        'INVALID_REQUEST',
        'The skill ZIP is invalid.',
      );
    }
    const appId = session.appId as AppId;
    let skill: SkillCatalogItem;
    try {
      const uploaded = parseSkillZipUpload(request.data);
      const markdown = uploaded.assets.find(
        (asset) => asset.path === 'SKILL.md',
      );
      const name = markdown
        ? (readSkillFrontmatterName(
            Buffer.from(markdown.content).toString('utf-8'),
          ) ?? uploaded.fallbackName)
        : uploaded.fallbackName;
      skill = await withSkillMaterializationLock(
        skillMaterializationLockKey(
          appId,
          materializedSkillDirectoryNameFor(name),
        ),
        () =>
          skillService().installSkill({
            appId,
            createdBy: `browser:${session.userId}`,
            fallbackName: uploaded.fallbackName,
            assets: uploaded.assets,
          }),
      );
    } catch {
      return browserError(
        res,
        400,
        'INVALID_SKILL_PACKAGE',
        'The skill ZIP could not be installed.',
      );
    }
    const storage = getRuntimeStorage();
    const agents = await storage.repositories.agents.listAgents(appId);
    const bindings =
      await storage.repositories.skills.listAgentSkillBindingsForAgents({
        appId,
        agentIds: agents.map((agent) => agent.id),
      });
    if (
      bindings.some(
        (binding) =>
          binding.skillId === skill.id && binding.status === 'active',
      )
    ) {
      try {
        await ctx.syncSettingsFromProjection(appId);
      } catch (error) {
        logger.error(
          { err: error, appId, skillId: skill.id },
          'Browser skill settings projection failed',
        );
        return browserError(
          res,
          500,
          'SETTINGS_PROJECTION_FAILED',
          'Skill was installed, but runtime settings could not be refreshed.',
        );
      }
    }
    sendJson(res, 201, {
      skill: browserSkillResponse(skill, agents, bindings),
    });
    return true;
  }

  const files = BROWSER_SKILL_FILES_PATH.exec(pathname);
  if (files && req.method === 'GET') {
    const session = await requireReadSession(req, res, mode);
    if (!session) return true;
    const appId = session.appId as AppId;
    const skillId = decoded(files[1]) as SkillId | null;
    if (!skillId) {
      return browserError(res, 400, 'INVALID_REQUEST', 'Invalid skill id.');
    }
    const storage = getRuntimeStorage();
    const skill = await storage.repositories.skills.getSkill(skillId);
    if (!skill || skill.appId !== appId) {
      return browserError(res, 404, 'NOT_FOUND', 'Skill files were not found.');
    }
    if (!skill.storage) {
      if (!files[2] && skill.source === 'bundled') {
        sendJson(res, 200, { skillId, files: [] });
        return true;
      }
      return browserError(res, 404, 'NOT_FOUND', 'Skill files were not found.');
    }
    let bundle;
    try {
      bundle = await readVerifiedSkillArtifact({
        skill,
        artifactStore: storage.skillArtifacts,
      });
    } catch (error) {
      logger.error(
        { err: error, appId, skillId },
        'Browser skill files are unavailable',
      );
      return browserError(
        res,
        500,
        'SKILL_FILES_UNAVAILABLE',
        'Skill files are unavailable.',
      );
    }
    if (!files[2]) {
      sendJson(res, 200, {
        skillId,
        files: bundle.assets.map(browserSkillFileMetadata),
      });
      return true;
    }
    let requestedPath: string;
    try {
      const value = decoded(files[2]);
      if (!value) throw new Error('Invalid path');
      requestedPath = normalizeRequestedSkillFilePath(value);
    } catch {
      return browserError(
        res,
        400,
        'INVALID_REQUEST',
        'Invalid skill file path.',
      );
    }
    const asset = bundle.assets.find((item) => item.path === requestedPath);
    if (!asset) {
      return browserError(res, 404, 'NOT_FOUND', 'Skill file was not found.');
    }
    sendJson(res, 200, { skillId, file: browserSkillFile(asset) });
    return true;
  }

  const agentsPath = BROWSER_SKILL_AGENTS_PATH.exec(pathname);
  if (agentsPath && req.method === 'GET') {
    const session = await requireReadSession(req, res, mode);
    if (!session) return true;
    const appId = session.appId as AppId;
    const skillId = decoded(agentsPath[1]) as SkillId | null;
    if (!skillId) {
      return browserError(res, 400, 'INVALID_REQUEST', 'Invalid skill id.');
    }
    const storage = getRuntimeStorage();
    const skill = await storage.repositories.skills.getSkill(skillId);
    if (!skill || skill.appId !== appId) {
      return browserError(res, 404, 'NOT_FOUND', 'Skill was not found.');
    }
    const agents = await storage.repositories.agents.listAgents(appId);
    const bindings =
      await storage.repositories.skills.listAgentSkillBindingsForAgents({
        appId,
        agentIds: agents.map((agent) => agent.id),
      });
    sendJson(res, 200, {
      skillId,
      agents: browserSkillAttachmentAgents(agents, skillId, bindings),
    });
    return true;
  }

  if (agentsPath && req.method === 'PUT') {
    const session = await requireMutationSession(req, res, settings);
    if (!session) return true;
    let body: unknown;
    try {
      body = await readJson(req);
    } catch {
      return browserError(
        res,
        400,
        'INVALID_REQUEST',
        'Request body must be valid JSON.',
      );
    }
    const request = ReplaceBrowserSkillAttachmentsRequestSchema.safeParse(body);
    const skillId = decoded(agentsPath[1]) as SkillId | null;
    if (!request.success || !skillId) {
      return browserError(
        res,
        400,
        'INVALID_REQUEST',
        'Choose up to 100 distinct agents.',
      );
    }
    const appId = session.appId as AppId;
    const storage = getRuntimeStorage();
    const [skill, agents] = await Promise.all([
      storage.repositories.skills.getSkill(skillId),
      storage.repositories.agents.listAgents(appId),
    ]);
    const appAgentIds = new Set(agents.map((agent) => agent.id));
    if (
      !skill ||
      skill.appId !== appId ||
      skill.status !== 'installed' ||
      request.data.agentIds.some(
        (agentId) => !appAgentIds.has(agentId as AgentId),
      )
    ) {
      return browserError(res, 404, 'NOT_FOUND', 'Skill or agent not found.');
    }
    const bindings = await skillService().replaceSkillAgentBindings({
      appId,
      skillId,
      agentIds: request.data.agentIds as AgentId[],
    });
    try {
      await ctx.syncSettingsFromProjection(appId);
    } catch (error) {
      logger.error(
        { err: error, appId, skillId },
        'Browser skill settings projection failed',
      );
      return browserError(
        res,
        500,
        'SETTINGS_PROJECTION_FAILED',
        'Skill attachments were saved, but runtime settings could not be refreshed.',
      );
    }
    sendJson(res, 200, {
      skillId,
      agents: browserSkillAttachmentAgents(agents, skillId, bindings),
    });
    return true;
  }

  if (
    pathname === BROWSER_SKILLS_PATH ||
    pathname === BROWSER_SKILL_INSTALL_PATH ||
    files ||
    agentsPath
  ) {
    res.setHeader(
      'Allow',
      pathname === BROWSER_SKILLS_PATH
        ? 'GET'
        : pathname === BROWSER_SKILL_INSTALL_PATH
          ? 'POST'
          : agentsPath
            ? 'GET, PUT'
            : 'GET',
    );
    return browserError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
  }
  return browserError(res, 404, 'NOT_FOUND', 'Skill route not found.');
}

async function requireReadSession(
  req: IncomingMessage,
  res: ServerResponse,
  mode: 'local' | 'hosted',
) {
  const session = await activeSession(req, mode);
  if (!session) {
    browserError(res, 401, 'UNAUTHORIZED', 'Sign in is required.');
    return null;
  }
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'skills:read')) {
    browserError(res, 403, 'FORBIDDEN', 'Viewer access is required.');
    return null;
  }
  return session;
}

async function requireMutationSession(
  req: IncomingMessage,
  res: ServerResponse,
  settings: BrowserSkillSettings,
) {
  const mode = settings.authentication.mode;
  const session = await requireBrowserMutationSession({
    req,
    res,
    mode,
    originIsValid: isCanonicalBrowserOrigin(
      req,
      settings.authentication.canonicalOrigin,
    ),
  });
  if (!session) return null;
  if (!browserRoleAllowsScope(session.role as ConsoleRole, 'skills:admin')) {
    browserError(res, 403, 'FORBIDDEN', 'Administrator access is required.');
    return null;
  }
  if (
    mode === 'hosted' &&
    !isRecentlyReauthenticated(session.reauthenticatedAt)
  ) {
    browserError(
      res,
      401,
      'REAUTHENTICATION_REQUIRED',
      'Sign in again to continue.',
    );
    return null;
  }
  return session;
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function browserError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): true {
  sendError(res, status, code, message);
  return true;
}
