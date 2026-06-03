import type { IncomingMessage, ServerResponse } from 'node:http';

import { AgentAccessRequestSchema } from '@gantry/contracts';

import { AgentCapabilityAdministrationService } from '../../../application/agents/agent-capability-administration-service.js';
import { ApplicationError } from '../../../application/common/application-error.js';
import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { McpServerDefinition } from '../../../domain/mcp/mcp-servers.js';
import type { SkillCatalogItem } from '../../../domain/skills/skills.js';
import type { ToolCatalogItem } from '../../../domain/tools/tools.js';
import type { AgentToolAccessView } from '../../../shared/tool-access-view.js';
import type { AgentAccessSummary } from '../../../application/agents/agent-access-summary.js';
import { semanticCapabilityFromToolCatalogItem } from '../../../shared/semantic-capabilities.js';
import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import { readJson, sendError, sendJson } from '../http.js';

function service(): AgentCapabilityAdministrationService {
  return new AgentCapabilityAdministrationService(
    getRuntimeStorage().repositories,
  );
}

export async function handleCapabilityCatalogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/capability-catalog') {
    sendError(
      res,
      410,
      'GONE',
      'Capability catalog moved to /v1/inventory and /v1/capabilities.',
    );
    return true;
  }

  if (pathname === '/v1/inventory' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const catalog = await service().listCatalog(auth.appId as AppId);
    sendJson(res, 200, {
      inventory: {
        tools: catalog.tools.map(toolToResponse),
        skills: catalog.skills.map(skillToResponse),
        mcpServers: catalog.mcpServers.map(mcpServerToResponse),
      },
    });
    return true;
  }

  if (pathname === '/v1/capabilities' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const catalog = await service().listCatalog(auth.appId as AppId);
    sendJson(res, 200, {
      capabilities: catalog.tools.map(toolToCapabilityResponse).filter(Boolean),
    });
    return true;
  }

  const capabilityMatch = pathname.match(/^\/v1\/capabilities\/([^/]+)$/);
  if (capabilityMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const catalog = await service().listCatalog(auth.appId as AppId);
    const decodedId = decodeURIComponent(capabilityMatch[1]);
    const capability = catalog.tools
      .map(toolToCapabilityResponse)
      .find((item) => item?.id === decodedId);
    if (!capability) {
      sendError(res, 404, 'NOT_FOUND', `Capability not found: ${decodedId}`);
      return true;
    }
    sendJson(res, 200, capability);
    return true;
  }

  const agentAccessMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/access$/);
  if (agentAccessMatch && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    try {
      const access = await service().getCapabilities({
        appId: auth.appId as AppId,
        agentId: decodeURIComponent(agentAccessMatch[1]) as AgentId,
      });
      sendJson(res, 200, accessToResponse(access));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (agentAccessMatch && req.method === 'PUT') {
    const auth = authorizeControlRequest(req, res, ctx.keys, ['agents:admin']);
    if (!auth) return true;
    const parsed = AgentAccessRequestSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      sendError(res, 400, 'INVALID_REQUEST', 'Invalid agent access document');
      return true;
    }
    const appId = auth.appId as AppId;
    const agentId = decodeURIComponent(agentAccessMatch[1]) as AgentId;
    try {
      const access = await service().replaceAccessDocument({
        appId,
        agentId,
        sources: parsed.data.sources,
        capabilities: parsed.data.selections,
      });
      await ctx.syncSettingsFromProjection(appId);
      sendJson(res, 200, accessToResponse(access));
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  return false;
}

function accessToResponse(input: {
  agentId: string;
  sources: unknown;
  capabilities: Array<{ id: string; version: string }>;
  toolAccess: AgentToolAccessView;
  summary: AgentAccessSummary;
  updatedAt: string;
}) {
  const { capabilities, ...rest } = input;
  return { ...rest, selections: capabilities };
}

function toolToCapabilityResponse(tool: ToolCatalogItem) {
  const semanticCapability = semanticCapabilityFromToolCatalogItem({
    name: tool.name,
    inputSchema: tool.inputSchema,
  });
  if (semanticCapability) {
    return {
      id: semanticCapability.capabilityId,
      version: semanticCapability.version ?? 'builtin',
      displayName: semanticCapability.displayName,
      category: semanticCapability.category,
      risk: semanticCapability.risk,
      can: semanticCapability.can,
      cannot: semanticCapability.cannot,
      source: semanticCapability.credentialSource,
      sourceRefs: semanticCapability.source ?? {},
      bindings: semanticCapability.implementationBindings,
      inputs: semanticCapabilityInput(tool),
      secrets: [],
      preflight: semanticCapability.preflight,
      sandbox: semanticCapability.sandboxProfile,
      protectedPaths: semanticCapability.protectedPaths ?? [],
      redaction: semanticCapability.redactionPolicy ?? {},
      approval: { persistent: true },
      audit: { manifest: 'gantry.capability.v1' },
    };
  }
  if (tool.name === 'Browser') {
    return {
      id: 'browser.use',
      version: 'builtin',
      displayName: 'Browser',
      category: 'Browser',
      risk: 'write',
      can: 'Use the Gantry-owned browser gateway tools.',
      cannot:
        'Receive private browser backend credentials or persist per-action browser tools.',
      source: 'builtin',
      sourceRefs: { toolId: tool.id },
      bindings: [{ kind: 'gantry_tool', tool: 'Browser' }],
      inputs: {},
      secrets: [],
      preflight: { kind: 'none' },
      sandbox: {},
      protectedPaths: [],
      redaction: {},
      approval: { persistent: true },
      audit: { manifest: 'gantry.capability.v1' },
    };
  }
  return undefined;
}

function semanticCapabilityInput(tool: ToolCatalogItem) {
  return toSchemaDescriptor(tool.inputSchema);
}

function toolToResponse(tool: ToolCatalogItem) {
  const semanticCapability = semanticCapabilityFromToolCatalogItem({
    name: tool.name,
    inputSchema: tool.inputSchema,
  });
  return {
    id: tool.id,
    appId: tool.appId,
    name: tool.name,
    kind: tool.kind,
    provider: tool.provider,
    providerToolName: tool.providerToolName,
    displayName: tool.displayName,
    description: tool.description,
    category: tool.category,
    inputSchema: toSchemaDescriptor(tool.inputSchema),
    outputSchema: tool.outputSchema
      ? toSchemaDescriptor(tool.outputSchema)
      : undefined,
    risk: tool.risk,
    selectable: tool.selectable,
    status: tool.status,
    permissionPolicyId: tool.permissionPolicyId,
    sandboxProfileId: tool.sandboxProfileId,
    adapterRef: tool.adapterRef,
    ...(semanticCapability ? { semanticCapability } : {}),
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
  };
}

function skillToResponse(skill: SkillCatalogItem) {
  return {
    id: skill.id,
    appId: skill.appId,
    agentId: skill.agentId,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    status: skill.status,
    promptRefs: skill.promptRefs,
    toolIds: skill.toolIds,
    workflowRefs: skill.workflowRefs,
    storage: skill.storage
      ? {
          storageType: skill.storage.storageType,
          storageRef: skill.storage.storageRef,
          sizeBytes: skill.storage.sizeBytes,
        }
      : undefined,
    createdBy: skill.createdBy,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

function mcpServerToResponse(server: McpServerDefinition) {
  return {
    id: server.id,
    appId: server.appId,
    name: server.name,
    displayName: server.displayName,
    description: server.description,
    status: server.status,
    createdSource: server.createdSource,
    riskClass: server.riskClass,
    requestedBy: server.requestedBy,
    requestedReason: server.requestedReason,
    transport: server.transport,
    config: server.config,
    allowedToolPatterns: server.allowedToolPatterns,
    autoApproveToolPatterns: server.autoApproveToolPatterns,
    credentialRefs: server.credentialRefs,
    sandboxProfileId: server.sandboxProfileId,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    disabledBy: server.disabledBy,
    disabledAt: server.disabledAt,
  };
}

function toSchemaDescriptor(value: unknown) {
  if (
    value &&
    typeof value === 'object' &&
    'format' in value &&
    'schema' in value
  ) {
    return value;
  }
  return {
    format: 'unknown',
    schema:
      value && typeof value === 'object' && !Array.isArray(value) ? value : {},
  };
}

function sendApplicationError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ApplicationError)) return false;
  const statusByCode: Record<string, number> = {
    NOT_FOUND: 404,
    FORBIDDEN: 403,
    INVALID_REQUEST: 400,
    CONFLICT: 409,
    UNAVAILABLE: 503,
    NOT_IMPLEMENTED: 501,
  };
  sendError(res, statusByCode[error.code] ?? 400, error.code, error.message);
  return true;
}
