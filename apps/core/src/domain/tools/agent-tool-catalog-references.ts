import type { AppId } from '../app/app.js';
import type { ToolCatalogRepository } from '../ports/repositories.js';
import type { ToolCatalogItem, ToolId } from './tools.js';
import {
  adminMcpToolIdForFullName,
  isAdminMcpToolFullName,
} from '../../shared/admin-mcp-tools.js';
import {
  persistentPermissionToolId,
  validateReadableAgentToolRule,
} from '../../shared/agent-tool-references.js';

export async function ensureAgentToolCatalogItem(input: {
  repository: ToolCatalogRepository;
  appId: AppId;
  reference: string;
  now: string;
  description?: string;
  adapterRef?: string;
}): Promise<ToolCatalogItem> {
  const resolved = await resolveAgentToolReference(input);
  if (resolved.tool) return resolved.tool;
  if (resolved.error) throw new Error(resolved.error);
  const allowedRule = input.reference.trim();
  const validation = validateReadableAgentToolRule(allowedRule);
  if (!validation.ok) throw new Error(validation.reason);
  const item: ToolCatalogItem = {
    id: persistentPermissionToolId(input.appId, allowedRule) as ToolId,
    appId: input.appId,
    name: allowedRule,
    kind: 'host',
    provider: 'myclaw',
    displayName: allowedRule,
    description:
      input.description ??
      'Persistent permission rule approved from settings.yaml.',
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

export async function resolveAgentToolReference(input: {
  repository: ToolCatalogRepository;
  appId: AppId;
  reference: string;
}): Promise<{ tool?: ToolCatalogItem; error?: string }> {
  const reference = input.reference.trim();
  if (!reference) return { error: 'Tool rule cannot be empty.' };
  if (reference.startsWith('tool:')) {
    return {
      error:
        'Tool rule must be readable; use a tool name or scoped rule, not an internal tool ID.',
    };
  }

  const direct = await input.repository.getTool(reference as ToolId);
  if (direct) return validateCatalogTool(input.appId, reference, direct);

  const activeTools = await input.repository.listTools({
    appId: input.appId,
    statuses: ['active'],
  });
  const byName = activeTools.find(
    (tool) => tool.selectable && tool.name === reference,
  );
  if (byName) return { tool: byName };

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
  return {};
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
