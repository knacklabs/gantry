import type { AppId } from '../app/app.js';
import type { ToolCatalogRepository } from '../ports/repositories.js';
import type { ToolCatalogItem, ToolId } from './tools.js';
import {
  adminMcpToolIdForFullName,
  isAdminMcpToolFullName,
} from '../../shared/admin-mcp-tools.js';
import {
  persistentPermissionToolId,
  parseReadableScopedToolRule,
  RUN_COMMAND_TOOL_NAME,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';
import {
  containsGeneratedRuntimeSkillPath,
  GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON,
} from '../../shared/generated-runtime-paths.js';
import {
  semanticCapabilityInputSchema,
  type SemanticCapabilityDefinition,
  validateSemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';
import {
  parseSemanticCapabilityRule,
  semanticCapabilityRule,
} from '../../shared/semantic-capability-ids.js';

export async function ensureAgentToolCatalogItem(input: {
  repository: ToolCatalogRepository;
  appId: AppId;
  reference: string;
  now: string;
  description?: string;
  adapterRef?: string;
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Promise<ToolCatalogItem> {
  const reference = input.reference.trim();
  const requestedSemanticCapabilityId = parseSemanticCapabilityRule(reference);
  const requestedCapability = requestedSemanticCapabilityId
    ? input.semanticCapabilityDefinitions?.[requestedSemanticCapabilityId]
    : undefined;
  if (requestedSemanticCapabilityId && requestedCapability) {
    return saveSemanticCapabilityTool({
      repository: input.repository,
      appId: input.appId,
      capabilityId: requestedSemanticCapabilityId,
      capability: requestedCapability,
      now: input.now,
    });
  }
  const resolved = await resolveAgentToolReference(input);
  if (resolved.tool) return resolved.tool;
  if (
    resolved.error &&
    !(
      requestedSemanticCapabilityId &&
      input.semanticCapabilityDefinitions?.[requestedSemanticCapabilityId]
    )
  ) {
    throw new Error(resolved.error);
  }
  const allowedRule = reference;
  const validation = validateReadableAgentToolRule(allowedRule);
  if (!validation.ok) throw new Error(validation.reason);
  const semanticCapabilityId = parseSemanticCapabilityRule(allowedRule);
  if (semanticCapabilityId) {
    const capability =
      input.semanticCapabilityDefinitions?.[semanticCapabilityId];
    if (!capability) {
      throw new Error(
        `Unknown semantic capability ${semanticCapabilityId}. Review and register a user-defined capability before selecting it.`,
      );
    }
    return saveSemanticCapabilityTool({
      repository: input.repository,
      appId: input.appId,
      capabilityId: semanticCapabilityId,
      capability,
      now: input.now,
    });
  }
  const scoped = parseReadableScopedToolRule(allowedRule);
  if (!scoped || scoped.toolName !== RUN_COMMAND_TOOL_NAME) {
    throw new Error(
      `Unknown tool capability ${allowedRule}. Select a catalog tool, semantic capability, or scoped RunCommand(...) rule.`,
    );
  }
  const item: ToolCatalogItem = {
    id: persistentPermissionToolId(input.appId, allowedRule) as ToolId,
    appId: input.appId,
    name: allowedRule,
    kind: 'host',
    provider: 'gantry',
    displayName: allowedRule,
    description:
      input.description ??
      'Persistent permission tool approved from settings.yaml.',
    category: 'admin',
    risk: 'high',
    selectable: true,
    status: 'active',
    adapterRef: input.adapterRef ?? 'permission/settings.yaml',
    createdAt: input.now as never,
    updatedAt: input.now as never,
  };
  await input.repository.saveTool(item);
  return item;
}

async function saveSemanticCapabilityTool(input: {
  repository: ToolCatalogRepository;
  appId: AppId;
  capabilityId: string;
  capability: SemanticCapabilityDefinition;
  now: string;
}): Promise<ToolCatalogItem> {
  const capabilityValidation = validateSemanticCapabilityDefinition(
    input.capability,
  );
  if (!capabilityValidation.ok) {
    throw new Error(capabilityValidation.reason);
  }
  const item: ToolCatalogItem = {
    id: `tool:capability:${input.capabilityId}` as ToolId,
    appId: input.appId,
    name: semanticCapabilityRule(input.capabilityId),
    kind:
      input.capability.credentialSource === 'local_cli' ? 'local_cli' : 'host',
    provider:
      input.capability.credentialSource === 'local_cli'
        ? 'local_cli'
        : 'gantry',
    displayName: input.capability.displayName,
    description: `${input.capability.can} Cannot: ${input.capability.cannot}`,
    category: 'productivity',
    risk: input.capability.risk === 'read' ? 'low' : 'high',
    selectable: true,
    status: 'active',
    inputSchema: semanticCapabilityInputSchema(input.capability),
    adapterRef: `capability/${input.capabilityId}`,
    createdAt: input.now as never,
    updatedAt: input.now as never,
  };
  await input.repository.saveTool(item);
  return item;
}

export async function resolveAgentToolReference(input: {
  repository: ToolCatalogRepository;
  appId: AppId;
  reference: string;
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Promise<{ tool?: ToolCatalogItem; error?: string }> {
  const reference = input.reference.trim();
  if (!reference) return { error: 'Tool rule cannot be empty.' };
  if (reference.startsWith('tool:')) {
    return {
      error:
        'Tool rule must be readable; use a tool name or scoped RunCommand rule, not an internal tool ID.',
    };
  }
  if (containsGeneratedRuntimeSkillPath(reference)) {
    return { error: GENERATED_RUNTIME_SKILL_PATH_DURABLE_REJECTION_REASON };
  }

  const activeTools = await input.repository.listTools({
    appId: input.appId,
    statuses: ['active'],
  });
  const byName = activeTools.find(
    (tool) => tool.selectable && tool.name === reference,
  );
  if (byName) return validateCatalogTool(input.appId, byName.id, byName);

  if (isAdminMcpToolFullName(reference)) {
    const adminId = adminMcpToolIdForFullName(reference);
    const adminTool = await input.repository.getTool(adminId as ToolId);
    if (adminTool) {
      return validateCatalogTool(input.appId, adminId, adminTool);
    }
    return { error: `Tool catalog row ${adminId} is unavailable.` };
  }

  const validation = validateReadableAgentToolRule(reference);
  if (!validation.ok) return { error: validation.reason };
  const semanticCapabilityId = parseSemanticCapabilityRule(reference);
  if (semanticCapabilityId) {
    if (input.semanticCapabilityDefinitions?.[semanticCapabilityId]) {
      return {};
    }
    return {
      error: `Unknown semantic capability ${semanticCapabilityId}. Review and register a user-defined capability before selecting it.`,
    };
  }
  const scoped = parseReadableScopedToolRule(reference);
  if (scoped?.toolName === RUN_COMMAND_TOOL_NAME) return {};
  if (reference.startsWith('mcp__')) {
    return {
      error:
        'Third-party MCP tool names are not selected directly; request and bind the MCP server capability.',
    };
  }
  return {
    error: `Unknown tool capability ${reference}. Select a catalog tool, semantic capability, or scoped RunCommand(...) rule.`,
  };
}

function validateCatalogTool(
  appId: AppId,
  reference: string,
  tool: ToolCatalogItem,
): { tool?: ToolCatalogItem; error?: string } {
  if (tool.appId !== appId || tool.status !== 'active' || !tool.selectable) {
    return { error: `Tool catalog row ${reference} is unavailable.` };
  }
  return { tool };
}
