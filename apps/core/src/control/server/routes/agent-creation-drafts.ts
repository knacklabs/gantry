import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  AgentCreationDocumentSchema,
  AgentCreationDraftSchema,
  CreateAgentCreationDraftRequestSchema,
  UpdateAgentCreationDraftRequestSchema,
} from '@gantry/contracts';

import { AgentCreationService } from '../../../application/agent-creation/agent-creation-service.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { AppId } from '../../../domain/app/app.js';
import type {
  AgentCreationDraft,
  AgentCreationDraftId,
} from '../../../domain/agent-creation/agent-creation-draft.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';
import { nowIso } from '../../../shared/time/datetime.js';

const DRAFT_PATH = '/v1/agent-creation-drafts';

function creationService(ctx: ControlRouteContext): AgentCreationService {
  const repositories = getRuntimeStorage().repositories;
  return new AgentCreationService({
    drafts: repositories.agentCreationDrafts,
    agents: repositories.agents,
    agentSettings: ctx.agentSettings,
    runtimeHome: ctx.runtimeHome,
    now: nowIso,
  });
}

function response(draft: AgentCreationDraft) {
  return AgentCreationDraftSchema.parse({
    id: draft.id,
    revision: draft.revision,
    status: draft.status,
    currentStep: draft.currentStep,
    document: AgentCreationDocumentSchema.parse(draft.document),
    progress: draft.progress,
    agentId: draft.agentId ?? null,
    jobId: draft.jobId ?? null,
    errorCode: draft.errorCode ?? null,
    errorMessage: draft.errorMessage ?? null,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    completedAt: draft.completedAt ?? null,
  });
}

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ApplicationError)) return false;
  if (error.code === 'NOT_FOUND') {
    sendError(res, 404, 'NOT_FOUND', error.message);
    return true;
  }
  if (error.code === 'CONFLICT') {
    sendError(res, 409, 'DRAFT_REVISION_CONFLICT', error.message);
    return true;
  }
  if (error.code === 'INVALID_REQUEST') {
    sendError(res, 400, 'INVALID_REQUEST', error.message);
    return true;
  }
  return false;
}

export async function handleAgentCreationDraftRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith(DRAFT_PATH)) return false;
  const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
  if (!auth) return true;
  const appId = auth.appId as AppId;
  const repositories = getRuntimeStorage().repositories;

  if (pathname === DRAFT_PATH && req.method === 'GET') {
    const drafts = await repositories.agentCreationDrafts.listDrafts(appId);
    sendJson(res, 200, { drafts: drafts.map(response) });
    return true;
  }

  if (pathname === DRAFT_PATH && req.method === 'POST') {
    const parsed = CreateAgentCreationDraftRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent creation draft');
      return true;
    }
    const now = nowIso();
    const saved = await repositories.agentCreationDrafts.saveDraft({
      draft: {
        id: `agent-creation-draft:${randomUUID()}` as AgentCreationDraftId,
        appId,
        revision: 1,
        status: 'draft',
        currentStep: parsed.data.currentStep,
        document: parsed.data.document,
        progress: {},
        createdAt: now,
        updatedAt: now,
      },
    });
    if (saved === 'conflict') {
      sendError(res, 409, 'DRAFT_REVISION_CONFLICT', 'Draft already exists');
      return true;
    }
    sendJson(res, 201, response(saved));
    return true;
  }

  const match = pathname.match(
    /^\/v1\/agent-creation-drafts\/([^/]+)(?:\/(preflight|create))?$/,
  );
  if (!match) return false;
  const id = decodeURIComponent(match[1]) as AgentCreationDraftId;
  const action = match[2];

  if (!action && req.method === 'GET') {
    const draft = await repositories.agentCreationDrafts.getDraft({
      appId,
      id,
    });
    if (!draft) {
      sendError(res, 404, 'NOT_FOUND', 'Creation draft not found');
      return true;
    }
    sendJson(res, 200, response(draft));
    return true;
  }

  if (!action && req.method === 'PUT') {
    const existing = await repositories.agentCreationDrafts.getDraft({
      appId,
      id,
    });
    if (!existing) {
      sendError(res, 404, 'NOT_FOUND', 'Creation draft not found');
      return true;
    }
    if (existing.agentId) {
      sendError(
        res,
        409,
        'DRAFT_ALREADY_APPLIED',
        'Draft has already created an agent',
      );
      return true;
    }
    const parsed = UpdateAgentCreationDraftRequestSchema.safeParse(
      await readJson(req),
    );
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent creation draft');
      return true;
    }
    const saved = await repositories.agentCreationDrafts.saveDraft({
      draft: {
        ...existing,
        currentStep: parsed.data.currentStep,
        document: parsed.data.document,
        status:
          existing.status === 'needs_attention' ? 'draft' : existing.status,
        errorCode: undefined,
        errorMessage: undefined,
        updatedAt: nowIso(),
      },
      expectedRevision: parsed.data.expectedRevision,
    });
    if (saved === 'conflict') {
      sendError(
        res,
        409,
        'DRAFT_REVISION_CONFLICT',
        'This draft changed elsewhere. Reload the saved draft before continuing.',
      );
      return true;
    }
    sendJson(res, 200, response(saved));
    return true;
  }

  if (!action && req.method === 'DELETE') {
    const deleted = await repositories.agentCreationDrafts.deleteDraft({
      appId,
      id,
    });
    if (deleted === 'not_found') {
      sendError(res, 404, 'NOT_FOUND', 'Creation draft not found');
      return true;
    }
    if (deleted === 'agent_exists') {
      sendError(
        res,
        409,
        'DRAFT_ALREADY_APPLIED',
        'Draft has already created an agent',
      );
      return true;
    }
    sendJson(res, 200, { deleted: true });
    return true;
  }

  if (action === 'preflight' && req.method === 'POST') {
    try {
      sendJson(res, 200, await creationService(ctx).preflight({ appId, id }));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (action === 'create' && req.method === 'POST') {
    try {
      const draft = await creationService(ctx).createOrResume({
        appId,
        id,
        leaseToken: randomUUID(),
      });
      sendJson(res, 200, response(draft));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  res.setHeader('Allow', action ? 'POST' : 'GET, PUT, DELETE');
  sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  return true;
}
