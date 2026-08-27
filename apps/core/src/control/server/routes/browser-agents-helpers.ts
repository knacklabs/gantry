import { getRuntimeStorage } from '../../../adapters/storage/postgres/runtime-store.js';
import { AgentCapabilityAdministrationService } from '../../../application/agents/agent-capability-administration-service.js';
import { CustomRoleService } from '../../../application/agents/custom-role-service.js';
import { builtInRolePrompt } from '../../../application/agents/prompt-profile-service.js';
import type {
  Agent,
  AgentId,
  CustomRoleId,
} from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import { AGENT_PERSONAS } from '../../../shared/agent-persona.js';
import { resolveModelSelectionForWorkload } from '../../../shared/model-catalog.js';
import { resolveExecutionRoute } from '../../../shared/model-execution-route.js';
import type { ControlRouteContext } from '../handler-context.js';

export function pageParams(url: URL) {
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get('pageSize')) || 25),
  );
  return { page, pageSize };
}

export function page<T>(items: T[], pageNumber: number, pageSize: number) {
  const total = items.length;
  const end = pageNumber * pageSize;
  return {
    data: items.slice((pageNumber - 1) * pageSize, end),
    page: pageNumber,
    pageSize,
    total,
    hasNext: end < total,
  };
}

export async function agentView(
  storage: ReturnType<typeof getRuntimeStorage>,
  agent: Agent,
) {
  const config = agent.currentConfigVersionId
    ? await storage.repositories.agentConfigs.getConfigVersion(
        agent.currentConfigVersionId,
      )
    : null;
  const installs =
    await storage.repositories.providerAccounts.listConversationInstalls(
      agent.appId,
      agent.id,
    );
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    roleId: config?.roleSnapshot?.sourceRoleId ?? null,
    roleName: config?.roleSnapshot?.displayName ?? null,
    rolePrompt: config?.roleSnapshot?.prompt ?? null,
    configVersion: config?.version ?? null,
    modelAlias: config?.modelAliasSnapshot ?? null,
    conversationCount: installs.filter((install) => install.status === 'active')
      .length,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

type BrowserRole = {
  id: string;
  name: string;
  prompt: string;
  kind: 'built-in' | 'custom';
  sourceRoleId?: string;
  createdAt?: string;
  updatedAt?: string;
  retainedAgentCount?: number;
};

export function roleView(role: Omit<BrowserRole, 'kind'>): BrowserRole {
  return {
    id: role.id,
    name: role.name,
    prompt: role.prompt,
    kind: 'custom',
    sourceRoleId: role.sourceRoleId,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export function builtInRoles(): BrowserRole[] {
  return AGENT_PERSONAS.map((persona) => ({
    id: `built-in:${persona}`,
    name: `${persona[0].toUpperCase()}${persona.slice(1)}`,
    prompt: builtInRolePrompt(persona, 'full'),
    kind: 'built-in',
  }));
}

export async function roleSnapshotFor(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
  roleId: string,
) {
  const builtIn = builtInRoles().find((role) => role.id === roleId);
  if (builtIn)
    return {
      displayName: builtIn.name,
      prompt: builtIn.prompt,
      sourceRoleId: builtIn.id,
    };
  const role = await storage.repositories.customRoles.getCustomRole(
    roleId as CustomRoleId,
  );
  if (!role || role.appId !== appId) {
    throw new Error('Selected role not found.');
  }
  return new CustomRoleService(storage.repositories.customRoles).snapshot(role);
}

export async function retainedAgentCounts(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
) {
  const agents = await storage.repositories.agents.listAgents(appId);
  const versions = await Promise.all(
    agents.map((agent) =>
      agent.currentConfigVersionId
        ? storage.repositories.agentConfigs.getConfigVersion(
            agent.currentConfigVersionId,
          )
        : null,
    ),
  );
  return versions.reduce((counts, version) => {
    const roleId = version?.roleSnapshot?.sourceRoleId;
    if (roleId) counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
}

export function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function assertAvailableAgentName(
  storage: ReturnType<typeof getRuntimeStorage>,
  appId: AppId,
  name: string,
  exceptId?: AgentId,
) {
  const normalized = name.trim().toLowerCase();
  const duplicate = (await storage.repositories.agents.listAgents(appId)).some(
    (agent) =>
      agent.id !== exceptId && agent.name.trim().toLowerCase() === normalized,
  );
  if (duplicate) throw new Error('An agent with this name already exists.');
}

export function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function requestedModelAlias(
  body: Record<string, unknown>,
): string | null | undefined {
  if (!Object.hasOwn(body, 'modelAlias')) return undefined;
  if (body.modelAlias === null) return null;
  if (typeof body.modelAlias !== 'string') {
    throw new Error('Model must be a configured model or deployment default.');
  }
  const value = body.modelAlias.trim();
  return value || null;
}

export async function validateModelAlias(
  ctx: ControlRouteContext,
  appId: AppId,
  agentId: AgentId,
  modelAlias: string | null,
) {
  if (!modelAlias) return;
  const selection = resolveModelSelectionForWorkload(modelAlias, 'chat');
  if (!selection.ok) throw new Error(selection.message);
  const configured = new Set(
    await ctx.getActiveModelCredentialProviderIds(appId),
  );
  if (!configured.has(selection.entry.modelRoute.id)) {
    throw new Error(
      `${selection.entry.modelRoute.label} is not configured for this deployment.`,
    );
  }
  const route = resolveExecutionRoute({
    entry: selection.entry,
    agentHarness: ctx.getSelectedAgentHarness(agentId.replace(/^agent:/, '')),
  });
  if (!route.ok) throw new Error(route.message);
}

export function capabilityService(
  storage: ReturnType<typeof getRuntimeStorage>,
) {
  const { repositories } = storage;
  return new AgentCapabilityAdministrationService({
    agents: repositories.agents,
    tools: repositories.tools,
    skills: repositories.skills,
    mcpServers: repositories.mcpServers,
  });
}
