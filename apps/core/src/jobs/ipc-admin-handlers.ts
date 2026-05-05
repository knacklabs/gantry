import { McpServerService } from '../application/mcp/mcp-server-service.js';
import { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import { SkillDraftService } from '../application/skills/skill-draft-service.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { nowIso } from '../infrastructure/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { TaskHandler } from './ipc-types.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { parseSkillDraftAssets } from './skill-draft-ipc.js';
import { getHostRuntimeCredentialEnv } from '../runtime/agent-spawn-host.js';
import {
  isPermanentPermissionDecision,
  persistRequestPermissionRules,
  requestPermissionDescription,
  requestPermissionQueuedMessage,
  requestPermissionReviewEffect,
  requestPermissionReviewSuggestions,
} from './request-permission-review.js';
import {
  requestSettingsUpdateHandler,
  serviceRestartHandler,
  settingsDesiredStateHandler,
} from './ipc-runtime-admin-handlers.js';
import {
  adminCapabilityRequiredMessage,
  sourceAgentHasAdminToolCapability,
} from './ipc-admin-authorization.js';

const refreshGroupsHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, conversationBindings } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
    reject('Only the setup/routing agent can refresh groups.', 'forbidden');
    return;
  }

  try {
    logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
    await deps.syncGroups(true);
    const availableGroups = await deps.getAvailableGroups();
    await deps.writeGroupsSnapshot(
      sourceGroup,
      true,
      availableGroups,
      new Set(Object.keys(conversationBindings)),
    );
    accept('Group metadata refresh completed.');
  } catch (err) {
    logger.error({ err, sourceGroup }, 'refresh_groups failed unexpectedly');
    reject(
      err instanceof Error ? err.message : 'Failed to refresh group metadata.',
      'internal_error',
    );
  }
};

const registerAgentHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, deps, conversationBindings } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!(await sourceAgentHasAdminToolCapability(context, 'register_agent'))) {
    logger.warn({ sourceGroup }, 'Unauthorized register_agent attempt blocked');
    reject(
      adminCapabilityRequiredMessage('register_agent'),
      'missing_capability',
    );
    return;
  }
  if (data.jid && data.name && data.folder && data.trigger) {
    if (!isValidGroupFolder(data.folder)) {
      logger.warn(
        { sourceGroup, folder: data.folder },
        'Invalid register_agent request - unsafe folder name',
      );
      reject(`Invalid agent folder: ${data.folder}`, 'invalid_request');
      return;
    }
    const existingGroup = conversationBindings[data.jid];
    await deps.registerGroup(data.jid, {
      name: data.name,
      folder: data.folder,
      trigger: data.trigger,
      added_at: nowIso(),
      agentConfig: data.agentConfig,
      requiresTrigger: data.requiresTrigger,
      isMain: existingGroup?.isMain,
    });
    accept(`Agent "${data.name}" registered.`);
    return;
  }
  logger.warn(
    { data },
    'Invalid register_agent request - missing required fields',
  );
  reject(
    'Missing required fields: jid, name, folder, trigger.',
    'invalid_request',
  );
};

const requestMcpServerHandler: TaskHandler = async (context) => {
  const { data, deps, sourceGroup, sourceGroupJids } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const payload = data.payload || {};
  const name = toTrimmedString(payload.name, { maxLen: 80 });
  const transport = toTrimmedString(payload.transport, { maxLen: 32 });
  const origin = toTrimmedString(payload.origin, { maxLen: 2048 });
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 }) || '';
  if (!name || !reason) {
    reject('Missing required fields: name and reason.', 'invalid_request');
    return;
  }
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceGroupJids,
    requestKind: 'MCP server',
    reject,
  });
  if (!requestedTargetJid) return;
  if (
    typeof deps.requestPermissionApproval !== 'function' ||
    typeof deps.sendMessage !== 'function'
  ) {
    reject(
      'MCP server requests require a configured approval surface.',
      'preflight_failed',
    );
    return;
  }
  if (transport !== 'http' && transport !== 'sse') {
    reject('transport must be http or sse.', 'invalid_request');
    return;
  }
  const requestedToolPatterns = Array.isArray(payload.requestedToolPatterns)
    ? payload.requestedToolPatterns.filter((item): item is string =>
        Boolean(toTrimmedString(item, { maxLen: 160 })),
      )
    : [];
  const credentialNeeds = Array.isArray(payload.credentialNeeds)
    ? payload.credentialNeeds.filter((item): item is string => {
        const parsed = toTrimmedString(item, { maxLen: 160 });
        return Boolean(parsed && headerNameForCredentialNeed(parsed));
      })
    : [];
  const storage = getRuntimeStorage();
  const service = new McpServerService(
    storage.repositories.mcpServers,
    undefined,
    {
      lookupHostname: deps.mcpHostnameLookup,
    },
  );
  try {
    const config = { transport, url: origin };
    const created = await service.createDraft({
      appId: DEFAULT_MEMORY_APP_ID as never,
      name,
      createdBy: `agent:${sourceGroup}`,
      createdSource: 'agent_request',
      requestedReason: reason,
      transportConfig: config as never,
      allowedToolPatterns: requestedToolPatterns,
      credentialRefs: credentialRefsForRequestedMcp(
        name,
        transport,
        credentialNeeds,
      ),
      riskClass: 'medium',
    });
    startMcpPermissionReview({
      deps,
      responder: { acceptData, reject },
      service,
      sourceGroup,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      server: created.definition,
      transport,
      origin: origin || '',
      requestedToolPatterns,
      credentialNeeds,
      reason,
    });
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'MCP server request failed.',
      'invalid_request',
    );
  }
};

const mcpListToolsHandler: TaskHandler = async (context) => {
  const { data, deps, sourceGroup, sourceGroupJids } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceGroupJids,
    requestKind: 'MCP tool list',
    reject,
  });
  if (!requestedTargetJid) return;
  try {
    const payload = data.payload || {};
    const serverName = toTrimmedString(payload.serverName, { maxLen: 80 });
    const proxy = await createMcpProxyForSourceGroup(sourceGroup, deps);
    const result = await proxy.listTools({
      appId: DEFAULT_MEMORY_APP_ID as never,
      agentId: memoryAgentIdForGroupFolder(sourceGroup) as never,
      ...(serverName ? { serverName } : {}),
    });
    acceptData('Approved MCP tools listed for this agent.', result);
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'MCP tool listing failed.',
      'mcp_proxy_failed',
    );
  }
};

const mcpCallToolHandler: TaskHandler = async (context) => {
  const { data, deps, sourceGroup, sourceGroupJids } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceGroupJids,
    requestKind: 'MCP tool call',
    reject,
  });
  if (!requestedTargetJid) return;
  try {
    const payload = data.payload || {};
    const serverName = toTrimmedString(payload.serverName, { maxLen: 80 });
    const toolName = toTrimmedString(payload.toolName, { maxLen: 160 });
    if (!serverName || !toolName) {
      reject(
        'Missing required fields: serverName and toolName.',
        'invalid_request',
      );
      return;
    }
    const args =
      payload.arguments &&
      typeof payload.arguments === 'object' &&
      !Array.isArray(payload.arguments)
        ? (payload.arguments as Record<string, unknown>)
        : {};
    const proxy = await createMcpProxyForSourceGroup(sourceGroup, deps);
    const result = await proxy.callTool({
      appId: DEFAULT_MEMORY_APP_ID as never,
      agentId: memoryAgentIdForGroupFolder(sourceGroup) as never,
      serverName,
      toolName,
      arguments: args,
    });
    acceptData(`MCP tool ${serverName}.${toolName} completed.`, result);
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'MCP tool call failed.',
      'mcp_proxy_failed',
    );
  }
};

const requestSkillDraftHandler: TaskHandler = async (context) => {
  const { data, deps, sourceGroup, sourceGroupJids } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const payload = data.payload || {};
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 }) || '';
  if (!reason) {
    reject('Missing required field: reason.', 'invalid_request');
    return;
  }
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceGroupJids,
    requestKind: 'Skill draft',
    reject,
  });
  if (!requestedTargetJid) return;
  if (
    typeof deps.requestPermissionApproval !== 'function' ||
    typeof deps.sendMessage !== 'function'
  ) {
    reject(
      'Skill draft requests require a configured approval surface.',
      'preflight_failed',
    );
    return;
  }

  const parsed = parseSkillDraftAssets(payload.files);
  if (!parsed.ok) {
    reject(parsed.error, 'invalid_request');
    return;
  }

  const storage = getRuntimeStorage();
  const service = new SkillDraftService(
    storage.repositories.skills,
    storage.skillArtifacts,
  );
  try {
    const draft = await service.importDraft({
      appId: DEFAULT_MEMORY_APP_ID as never,
      agentId: memoryAgentIdForGroupFolder(sourceGroup) as never,
      fallbackName: 'agent-created-skill',
      createdBy: `agent:${sourceGroup}`,
      assets: parsed.assets,
    });
    const responder = { acceptData, reject };
    startSkillPermissionReview({
      deps,
      responder,
      service,
      sourceGroup,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      skill: {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        contentHash: draft.storage?.contentHash,
      },
      assets: parsed.assets,
      fileSummaries: parsed.fileSummaries,
      skillMarkdownPreview: parsed.skillMarkdownPreview,
      totalSizeBytes: parsed.totalSizeBytes,
      reason,
      requestToolName: 'request_skill_proposal',
    });
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'Skill draft request failed.',
      'invalid_request',
    );
  }
};

// prettier-ignore
type RequestOnlyCapabilityToolName = 'request_skill_install' | 'request_skill_dependency_install' | 'request_permission';
// prettier-ignore
interface RequestOnlyCapabilityReview { toolName: RequestOnlyCapabilityToolName; requestKind: string; displayName: string; reason: string; toolInput: Record<string, unknown>; }
// prettier-ignore
const requestOnlyCapabilitySpecs: Record<RequestOnlyCapabilityToolName, { kind: string; required: string[]; any?: string[]; display: string; effect: string }> = {
  request_skill_install: { kind: 'Skill install', required: ['spec'], display: 'spec', effect: 'review_only_no_direct_install' },
  request_skill_dependency_install: { kind: 'Skill dependency install', required: ['ecosystem'], any: ['packages', 'commandArgv'], display: 'ecosystem', effect: 'review_only_no_command_execution' },
  request_permission: { kind: 'Permission', required: [], any: ['toolName', 'toolNames', 'channelTool'], display: 'toolName', effect: 'review_only_no_permission_change' },
};

// prettier-ignore
const requestOnlyCapabilityHandler: TaskHandler = async (context) => {
  const { data, deps, sourceGroup, sourceGroupJids } = context;
  const { accept, reject } = createTaskResponder(sourceGroup, data.taskId, data.authThreadId);
  const toolName = data.type as RequestOnlyCapabilityToolName;
  const parsed = parseRequestOnlyCapabilityReview(toolName, data.payload || {});
  if (!parsed.ok) { reject(parsed.error, 'invalid_request'); return; }
  const requestedTargetJid = validateSameChannelApprovalTarget({ data, sourceGroupJids, requestKind: parsed.review.requestKind, reject });
  if (!requestedTargetJid) return;
  if (typeof deps.requestPermissionApproval !== 'function' || typeof deps.sendMessage !== 'function') { reject(`${parsed.review.requestKind} requests require a configured approval surface.`, 'preflight_failed'); return; }
  startRequestOnlyCapabilityReview({ deps, sourceGroup, targetJid: requestedTargetJid, threadId: data.authThreadId, review: parsed.review });
  accept(requestOnlyCapabilityQueuedMessage(parsed.review), 'capability_request_recorded');
};

// prettier-ignore
export const adminTaskHandlers: Record<string, TaskHandler> = { refresh_groups: refreshGroupsHandler, register_agent: registerAgentHandler, service_restart: serviceRestartHandler, settings_desired_state: settingsDesiredStateHandler, request_settings_update: requestSettingsUpdateHandler, request_skill_install: requestOnlyCapabilityHandler, request_skill_dependency_install: requestOnlyCapabilityHandler, request_permission: requestOnlyCapabilityHandler, request_skill_proposal: requestSkillDraftHandler, request_mcp_server: requestMcpServerHandler, mcp_list_tools: mcpListToolsHandler, mcp_call_tool: mcpCallToolHandler };

// prettier-ignore
function validateSameChannelApprovalTarget(input: { data: Parameters<TaskHandler>[0]['data']; sourceGroupJids: string[]; requestKind: string; reject: (error: string, code?: string, details?: string[]) => void }): string | null {
  const requestedTargetJid = toTrimmedString(input.data.chatJid, { maxLen: 512 });
  const targetOverride = toTrimmedString(input.data.targetJid || input.data.jid, { maxLen: 512 });
  if (targetOverride && targetOverride !== requestedTargetJid) { input.reject(`${input.requestKind} requests must use the originating chat as the approval target.`, 'forbidden'); return null; }
  if (!requestedTargetJid || !input.sourceGroupJids.includes(requestedTargetJid)) { input.reject(`${input.requestKind} requests must include the originating chat for this agent.`, 'forbidden'); return null; }
  return requestedTargetJid;
}

// prettier-ignore
function parseRequestOnlyCapabilityReview(toolName: RequestOnlyCapabilityToolName, payload: Record<string, unknown>): { ok: true; review: RequestOnlyCapabilityReview } | { ok: false; error: string } {
  const spec = requestOnlyCapabilitySpecs[toolName];
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 }) || '';
  const missing = spec.required.filter((field) => !payloadHasValue(payload[field]));
  if (spec.any && !spec.any.some((field) => payloadHasValue(payload[field]))) missing.push(spec.any.join(' or '));
  if (!reason) missing.push('reason');
  if (missing.length > 0) return { ok: false, error: `Missing required fields: ${missing.join(', ')}.` };
  const toolInput = sanitizeCapabilityPayload(payload);
  if (toolName === 'request_permission') {
    const toolNames = sanitizedStringList([
      payload.toolName,
      ...(Array.isArray(payload.toolNames) ? payload.toolNames : []),
    ]);
    if (toolNames.length > 0) {
      delete toolInput.toolName;
      toolInput.toolNames = toolNames;
    }
  }
  if (toolName === 'request_skill_dependency_install' && !['npm', 'brew', 'go', 'uv', 'download'].includes(String(toolInput.ecosystem))) return { ok: false, error: 'ecosystem must be npm, brew, go, uv, or download.' };
  return {
    ok: true,
    review: {
      toolName,
      requestKind: spec.kind,
      displayName: `${spec.kind}: ${capabilityDisplayValue(payload, spec)}`,
      reason,
      toolInput: { ...toolInput, activation: 'future_config_version', effect: requestOnlyCapabilityEffect(toolName, toolInput, spec.effect) },
    },
  };
}

// prettier-ignore
function requestOnlyCapabilityEffect(toolName: RequestOnlyCapabilityToolName, toolInput: Record<string, unknown>, fallback: string): string {
  return toolName === 'request_permission'
    ? requestPermissionReviewEffect(toolInput, fallback)
    : fallback;
}

// prettier-ignore
function requestOnlyCapabilityQueuedMessage(review: RequestOnlyCapabilityReview): string {
  return review.toolName === 'request_permission'
    ? requestPermissionQueuedMessage({ toolName: 'request_permission', displayName: review.displayName })
    : `${review.displayName} request sent to this chat for approval. This records a permission review only and does not enable the capability directly.`;
}

// prettier-ignore
function payloadHasValue(value: unknown): boolean { return Array.isArray(value) ? value.some((item) => Boolean(toTrimmedString(item, { maxLen: 300 }))) : Boolean(toTrimmedString(value, { maxLen: 512 })); }

// prettier-ignore
function sanitizeCapabilityPayload(payload: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'reason') continue;
    if (Array.isArray(value)) {
      const list = sanitizedStringList(value);
      if (list.length > 0) output[key] = list;
    } else {
      if (typeof value === 'boolean') {
        output[key] = value;
        continue;
      }
      const item = toTrimmedString(value, { maxLen: 2048 });
      if (item) output[key] = item;
    }
  }
  return output;
}

function sanitizedStringList(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .slice(0, 50)
        .map((item) => toTrimmedString(item, { maxLen: 512 }))
        .filter((item): item is string => Boolean(item)),
    ),
  ];
}

// prettier-ignore
function capabilityDisplayValue(payload: Record<string, unknown>, spec: (typeof requestOnlyCapabilitySpecs)[RequestOnlyCapabilityToolName]): string {
  const primary = payload[spec.display];
  if (Array.isArray(primary)) { const joined = primary.map((item) => toTrimmedString(item, { maxLen: 512 })).filter((item): item is string => Boolean(item)).join(', '); if (joined) return joined; }
  const primaryText = toTrimmedString(primary, { maxLen: 512 });
  if (primaryText) return primaryText;
  for (const field of spec.any || []) {
    const value = payload[field];
    if (Array.isArray(value)) { const joined = value.map((item) => toTrimmedString(item, { maxLen: 512 })).filter((item): item is string => Boolean(item)).join(', '); if (joined) return joined; continue; }
    const text = toTrimmedString(value, { maxLen: 512 });
    if (text) return text;
  }
  return spec.kind;
}

// prettier-ignore
function startRequestOnlyCapabilityReview(input: { deps: Parameters<TaskHandler>[0]['deps']; sourceGroup: string; targetJid: string; threadId?: string; review: RequestOnlyCapabilityReview }): void {
  void (async () => {
    let message: string;
    try {
      const decision = await input.deps.requestPermissionApproval({
        requestId: `capability-${input.review.toolName}-${globalThis.crypto.randomUUID()}`,
        sourceGroup: input.sourceGroup,
        targetJid: input.targetJid,
        threadId: input.threadId,
        decisionPolicy: 'same_channel',
        toolName: input.review.toolName,
        displayName: input.review.displayName,
        title: `Approve ${input.review.requestKind.toLowerCase()} request`,
        description: input.review.toolName === 'request_permission' ? requestPermissionDescription() : 'Only configured approvers can decide this request. This records the permission review only and does not enable the capability directly.',
        decisionReason: input.review.reason,
        toolInput: input.review.toolInput,
        ...(input.review.toolName === 'request_permission'
          ? {
              suggestions: requestPermissionReviewSuggestions(
                input.review.toolInput,
              ),
            }
          : {}),
      });
      const reason = decision.approved ? 'missing approving principal' : decision.reason || 'not approved';
      let persistedRules: string[] = [];
      if (input.review.toolName === 'request_permission' && isPermanentPermissionDecision(decision)) {
        persistedRules = await persistRequestPermissionRules({
          deps: input.deps,
          sourceGroup: input.sourceGroup,
          updates: decision.updatedPermissions ?? [],
        });
      }
      message = decision.approved && decision.decidedBy
        ? persistedRules.length
          ? `Approved ${input.review.displayName}. Persistent permission rule enabled for future runs by ${decision.decidedBy}: ${persistedRules.join(', ')}.`
          : `Approved ${input.review.displayName}. Permission review recorded by ${decision.decidedBy}; no capability was enabled by this request-only flow.`
        : `Rejected ${input.review.displayName}: ${reason}. No capability was enabled.`;
    } catch (err) {
      logger.error(
        { err, sourceGroup: input.sourceGroup, toolName: input.review.toolName },
        'Capability permission review failed',
      );
      message = `Rejected ${input.review.displayName}: ${err instanceof Error ? err.message : 'permission review failed'}. No capability was enabled.`;
    }
    await input.deps.sendMessage(input.targetJid, message, input.threadId ? { threadId: input.threadId } : undefined);
  })().catch((err) => logger.error({ err, sourceGroup: input.sourceGroup, toolName: input.review.toolName }, 'Capability permission review final message failed'));
}

// prettier-ignore
function credentialRefsForRequestedMcp(serverName: string, transport: string, credentialNeeds: string[]) {
  if (transport === 'http' || transport === 'sse') {
    return credentialNeeds.map((ref, index) => ({
      name: brokerRefNameForAgentRequestedMcp(serverName, ref),
      target: 'header' as const,
      key: credentialNeeds.length === 1 && index === 0 ? 'Authorization' : headerNameForCredentialNeed(ref),
    }));
  }
  return credentialNeeds.map((ref) => ({ name: brokerRefNameForAgentRequestedMcp(serverName, ref), target: 'env' as const, key: headerNameForCredentialNeed(ref) }));
}

// prettier-ignore
function brokerRefNameForAgentRequestedMcp(serverName: string, credentialNeed: string): string {
  const server = serverName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const need = credentialNeed.replace(/_REF$/i, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `MCP_${server}_${need}_REF`;
}

// prettier-ignore
function headerNameForCredentialNeed(credentialNeed: string): string {
  return credentialNeed.replace(/_REF$/i, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// prettier-ignore
function startMcpPermissionReview(input: { deps: Parameters<TaskHandler>[0]['deps']; responder: Pick<ReturnType<typeof createTaskResponder>, 'acceptData' | 'reject'>; service: McpServerService; sourceGroup: string; targetJid: string; threadId?: string; server: { id: string; name: string }; transport: string; origin: string; requestedToolPatterns: string[]; credentialNeeds: string[]; reason: string }): void {
  void completeMcpPermissionReview(input).catch((err) => {
    logger.error(
      { err, serverId: input.server.id, sourceGroup: input.sourceGroup },
      'MCP permission review failed',
    );
    input.responder.reject(
      err instanceof Error ? err.message : 'MCP permission review failed.',
      'permission_review_failed',
    );
  });
}

async function completeMcpPermissionReview(
  input: Parameters<typeof startMcpPermissionReview>[0],
): Promise<void> {
  const decision = await input.deps.requestPermissionApproval({
    requestId: `mcp-${globalThis.crypto.randomUUID()}`,
    sourceGroup: input.sourceGroup,
    targetJid: input.targetJid,
    threadId: input.threadId,
    decisionPolicy: 'same_channel',
    toolName: 'request_mcp_server',
    displayName: `MCP server: ${input.server.name}`,
    title: 'Approve MCP server for this agent',
    description:
      'Only configured approvers can decide this request. Approving binds this MCP server and exposes it through the MyClaw MCP proxy for current and future runs.',
    decisionReason: input.reason,
    toolInput: {
      serverId: input.server.id,
      name: input.server.name,
      transport: input.transport,
      origin: input.origin,
      requestedToolPatterns: input.requestedToolPatterns,
      credentialNeeds: input.credentialNeeds,
      activation: 'current_and_future_sessions',
    },
  });

  if (!decision.approved) {
    await rejectMcpDraftFromPermission(input, decision.reason);
    return;
  }
  if (!decision.decidedBy) {
    await rejectMcpDraftFromPermission(input, 'missing approving principal');
    return;
  }

  await input.service.approveDraft({
    appId: DEFAULT_MEMORY_APP_ID as never,
    serverId: input.server.id as never,
    approvedBy: decision.decidedBy,
  });
  await input.service.bindToAgent({
    appId: DEFAULT_MEMORY_APP_ID as never,
    agentId: memoryAgentIdForGroupFolder(input.sourceGroup) as never,
    serverId: input.server.id as never,
  });
  const sameSessionContext = {
    type: 'approved_mcp_context',
    activation: 'current_and_future_sessions',
    server: {
      id: input.server.id,
      name: input.server.name,
      transport: input.transport,
      origin: input.origin,
    },
    approvedToolNames: input.requestedToolPatterns,
    currentSessionUsage: {
      listToolsTool: 'mcp__myclaw__mcp_list_tools',
      callToolTool: 'mcp__myclaw__mcp_call_tool',
      serverName: input.server.name,
    },
  };
  await input.deps.sendMessage(
    input.targetJid,
    `Approved MCP server ${input.server.name}. Use mcp_list_tools and mcp_call_tool for this server in current and future sessions.`,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.acceptData(
    `Approved MCP server ${input.server.name}. Use mcp_list_tools and mcp_call_tool in this current run and future sessions.`,
    sameSessionContext,
    'mcp_approved',
  );
}

async function rejectMcpDraftFromPermission(
  input: Parameters<typeof startMcpPermissionReview>[0],
  reason?: string,
): Promise<void> {
  await input.service.rejectDraft({
    appId: DEFAULT_MEMORY_APP_ID as never,
    serverId: input.server.id as never,
    rejectedBy: 'permission_review',
    reason,
  });
  await input.deps.sendMessage(
    input.targetJid,
    `Rejected MCP server ${input.server.name}: ${reason || 'not approved'}.`,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.reject(
    `Rejected MCP server ${input.server.name}: ${reason || 'not approved'}.`,
    'permission_denied',
  );
}

async function createMcpProxyForSourceGroup(
  sourceGroup: string,
  deps: Parameters<TaskHandler>[0]['deps'],
): Promise<McpToolProxy> {
  const storage = getRuntimeStorage();
  const credentials = await getHostRuntimeCredentialEnv(
    memoryAgentIdForGroupFolder(sourceGroup),
  );
  return new McpToolProxy(storage.repositories.mcpServers, {
    credentialEnv: credentials.env,
    lookupHostname: deps.mcpHostnameLookup,
  });
}

function startSkillPermissionReview(input: {
  deps: Parameters<TaskHandler>[0]['deps'];
  responder: Pick<
    ReturnType<typeof createTaskResponder>,
    'acceptData' | 'reject'
  >;
  service: SkillDraftService;
  sourceGroup: string;
  targetJid: string;
  threadId?: string;
  skill: {
    id: string;
    name: string;
    description?: string;
    contentHash?: string;
  };
  assets: Array<{
    path: string;
    contentType?: string;
    content: Uint8Array;
  }>;
  fileSummaries: Array<{
    path: string;
    sizeBytes: number;
    contentHash: string;
  }>;
  skillMarkdownPreview: {
    path: string;
    content: string;
    truncated: boolean;
    contentHash: string;
  };
  totalSizeBytes: number;
  reason: string;
  requestToolName: 'request_skill_proposal';
}): void {
  void completeSkillPermissionReview(input).catch((err) => {
    logger.error(
      { err, skillId: input.skill.id, sourceGroup: input.sourceGroup },
      'Skill permission review failed',
    );
    input.responder.reject(
      err instanceof Error ? err.message : 'Skill permission review failed.',
      'permission_review_failed',
    );
  });
}

async function completeSkillPermissionReview(
  input: Parameters<typeof startSkillPermissionReview>[0],
): Promise<void> {
  const decision = await input.deps.requestPermissionApproval({
    requestId: `skill-${globalThis.crypto.randomUUID()}`,
    sourceGroup: input.sourceGroup,
    targetJid: input.targetJid,
    threadId: input.threadId,
    decisionPolicy: 'same_channel',
    toolName: input.requestToolName,
    displayName: `Skill: ${input.skill.name}`,
    title: 'Approve skill for this agent',
    description:
      'Only configured approvers can decide this request. Approving binds this skill, returns it to the current agent run, and materializes it for future runs.',
    decisionReason: input.reason,
    toolInput: {
      skillId: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      packageContentHash: input.skill.contentHash,
      skillMarkdownPreview: input.skillMarkdownPreview,
      files: input.fileSummaries,
      totalSizeBytes: input.totalSizeBytes,
      activation: 'current_and_future_sessions',
    },
  });

  if (!decision.approved) {
    await rejectSkillDraftFromPermission(input, decision.reason);
    return;
  }
  if (!decision.decidedBy) {
    await rejectSkillDraftFromPermission(input, 'missing approving principal');
    return;
  }

  await input.service.approveDraft({
    appId: DEFAULT_MEMORY_APP_ID as never,
    skillId: input.skill.id as never,
    approvedBy: decision.decidedBy,
  });
  await input.service.bindSkillToAgent({
    appId: DEFAULT_MEMORY_APP_ID as never,
    agentId: memoryAgentIdForGroupFolder(input.sourceGroup) as never,
    skillId: input.skill.id as never,
  });
  const sameSessionContext = buildApprovedSkillSameSessionContext(input);
  await input.deps.sendMessage(
    input.targetJid,
    `Approved skill ${input.skill.name}. It has been returned to the running agent and will also be available in future sessions.`,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.acceptData(
    `Approved skill ${input.skill.name}. It is available in this current run and future sessions.`,
    sameSessionContext,
    'skill_approved',
  );
}

async function rejectSkillDraftFromPermission(
  input: Parameters<typeof startSkillPermissionReview>[0],
  reason?: string,
): Promise<void> {
  await input.service.rejectDraft({
    appId: DEFAULT_MEMORY_APP_ID as never,
    skillId: input.skill.id as never,
    rejectedBy: 'permission_review',
  });
  await input.deps.sendMessage(
    input.targetJid,
    `Rejected skill ${input.skill.name}: ${reason || 'not approved'}.`,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.reject(
    `Rejected skill ${input.skill.name}: ${reason || 'not approved'}.`,
    'permission_denied',
  );
}

function buildApprovedSkillSameSessionContext(
  input: Parameters<typeof startSkillPermissionReview>[0],
): {
  type: 'approved_skill_context';
  activation: 'current_and_future_sessions';
  skill: {
    id: string;
    name: string;
    description?: string;
    contentHash?: string;
  };
  files: Array<{
    path: string;
    contentType?: string;
    content: string;
    contentHash?: string;
    sizeBytes?: number;
  }>;
} {
  const summariesByPath = new Map(
    input.fileSummaries.map((summary) => [summary.path, summary]),
  );
  return {
    type: 'approved_skill_context',
    activation: 'current_and_future_sessions',
    skill: input.skill,
    files: input.assets.map((asset) => {
      const summary = summariesByPath.get(asset.path);
      return {
        path: asset.path,
        ...(asset.contentType ? { contentType: asset.contentType } : {}),
        content: Buffer.from(asset.content).toString('utf-8'),
        ...(summary
          ? {
              contentHash: summary.contentHash,
              sizeBytes: summary.sizeBytes,
            }
          : {}),
      };
    }),
  };
}
