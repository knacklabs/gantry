import path from 'path';

import { McpServerService } from '../application/mcp/mcp-server-service.js';
import { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import { SkillDraftService } from '../application/skills/skill-draft-service.js';
import {
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  MYCLAW_HOME,
  syncRuntimeSettingsFromProjection,
} from '../config/index.js';
import { nowIso } from '../shared/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { TaskContext, TaskHandler } from './ipc-types.js';
import { memoryAgentIdForGroupFolder } from '../memory/app-memory-boundaries.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { parseSkillDraftAssets } from './skill-draft-ipc.js';
import { startSkillPermissionReview } from './ipc-skill-permission-review.js';
import { getHostRuntimeCredentialEnv } from '../runtime/agent-spawn-host.js';
import {
  isPermanentPermissionDecision,
  formatPersistentPermissionRulesForUser,
  persistRequestPermissionRules,
  requestPermissionDescription,
  requestPermissionQueuedMessage,
  requestPermissionReviewEffect,
  requestPermissionReviewSuggestions,
  validateRequestPermissionSemanticCapability,
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
import {
  BROWSER_ACTION_MCP_RULE_REJECTION_REASON,
  BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON,
  isBrowserActionMcpToolRule,
  isProjectedBrowserMcpToolRule,
} from '../shared/agent-tool-references.js';
import { getBuiltinSemanticCapability } from '../shared/semantic-capabilities.js';
import { jobLocalCliCapabilityConflict } from './ipc-request-permission-local-cli.js';

const pendingRequestOnlyCapabilityReviews = new Set<string>();

function createContextTaskResponder(context: TaskContext) {
  return createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
}

const refreshGroupsHandler: TaskHandler = async (context) => {
  const { sourceAgentFolder, deps, conversationBindings } = context;
  const { accept, reject } = createContextTaskResponder(context);

  try {
    logger.info(
      { sourceAgentFolder },
      'Group metadata refresh requested via IPC',
    );
    await deps.syncGroups(true);
    const availableGroups = await deps.getAvailableGroups();
    await deps.writeGroupsSnapshot(
      sourceAgentFolder,
      availableGroups,
      new Set(Object.keys(conversationBindings)),
    );
    accept('Group metadata refresh completed.');
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'refresh_groups failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to refresh group metadata.',
      'internal_error',
    );
  }
};

// prettier-ignore
const registerAgentHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder, deps, sourceAgentFolderJids } = context;
  const { accept, reject } = createContextTaskResponder(context);
  if (!data.appId) { reject('Agent registration requires signed app scope.', 'forbidden'); return; }
  if (!(await sourceAgentHasAdminToolCapability(context, 'register_agent'))) { logger.warn({ sourceAgentFolder }, 'Unauthorized register_agent attempt blocked'); reject(adminCapabilityRequiredMessage('register_agent'), 'missing_capability'); return; }
  if (!data.jid || !data.name || !data.folder || !data.trigger) { logger.warn({ data }, 'Invalid register_agent request - missing required fields'); reject('Missing required fields: jid, name, folder, trigger.', 'invalid_request'); return; }
  const requestedTargetJid = validateSameChannelApprovalTarget({ data, sourceAgentFolderJids, requestKind: 'Agent registration', reject });
  if (!requestedTargetJid) return;
  if (data.jid !== requestedTargetJid) { reject('Agent registration can only bind the originating conversation.', 'forbidden'); return; }
  if (typeof deps.requestPermissionApproval !== 'function' || typeof deps.sendMessage !== 'function') { reject('Agent registration requests require a configured approval surface.', 'preflight_failed'); return; }
  if (!isValidGroupFolder(data.folder)) { logger.warn({ sourceAgentFolder, folder: data.folder }, 'Invalid register_agent request - unsafe folder name'); reject(`Invalid agent folder: ${data.folder}`, 'invalid_request'); return; }
  const reason = toTrimmedString(data.payload?.reason, { maxLen: 2000 }) || `Register ${data.name} for ${data.jid}.`;
  const decision = await deps.requestPermissionApproval({
    requestId: `register-agent-${globalThis.crypto.randomUUID()}`,
    appId: data.appId as never,
    agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
    sourceAgentFolder,
    targetJid: requestedTargetJid,
    threadId: data.authThreadId,
    decisionPolicy: 'same_channel',
    toolName: 'register_agent',
    displayName: `Register agent: ${data.name}`,
    title: 'Approve agent registration',
    description: 'Approving binds this agent to the originating conversation and writes the desired-state settings projection.',
    decisionReason: reason,
    toolInput: { jid: data.jid, name: data.name, folder: data.folder, trigger: data.trigger, requiresTrigger: data.requiresTrigger, activation: 'current_and_future_sessions' },
  });
  if (!decision.approved || !decision.decidedBy) { const message = `Rejected agent registration: ${decision.reason || 'not approved'}.`; reject(message, 'permission_denied'); await deps.sendMessage(requestedTargetJid, message, data.authThreadId ? { threadId: data.authThreadId } : undefined); return; }
  await deps.registerGroup(data.jid, { name: data.name, folder: data.folder, trigger: data.trigger, added_at: nowIso(), agentConfig: data.agentConfig, requiresTrigger: data.requiresTrigger });
  await syncApprovedCapabilitySettings(data.appId as never);
  accept(`Agent "${data.name}" registered.`);
};

const requestMcpServerHandler: TaskHandler = async (context) => {
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createContextTaskResponder(context);
  if (!data.appId) {
    reject('MCP tool listing requires signed app scope.', 'forbidden');
    return;
  }
  const payload = data.payload || {};
  if (!data.appId) {
    reject('Skill draft requests require signed app scope.', 'forbidden');
    return;
  }
  if (!data.appId) {
    reject('MCP server requests require signed app scope.', 'forbidden');
    return;
  }
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
    sourceAgentFolderJids,
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
      appId: data.appId as never,
      name,
      createdBy: `agent:${sourceAgentFolder}`,
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
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
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
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createContextTaskResponder(context);
  if (!data.appId) {
    reject('MCP tool listing requires signed app scope.', 'forbidden');
    return;
  }
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceAgentFolderJids,
    requestKind: 'MCP tool list',
    reject,
  });
  if (!requestedTargetJid) return;
  try {
    const payload = data.payload || {};
    const serverName = toTrimmedString(payload.serverName, { maxLen: 80 });
    const proxy = await createMcpProxyForSourceGroup(sourceAgentFolder, deps);
    const result = await proxy.listTools({
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
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
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createContextTaskResponder(context);
  if (!data.appId) {
    reject('MCP tool calls require signed app scope.', 'forbidden');
    return;
  }
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceAgentFolderJids,
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
    const proxy = await createMcpProxyForSourceGroup(sourceAgentFolder, deps);
    const result = await proxy.callTool({
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
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
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createContextTaskResponder(context);
  const payload = data.payload || {};
  if (!data.appId) {
    reject('Skill draft requests require signed app scope.', 'forbidden');
    return;
  }
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 }) || '';
  if (!reason) {
    reject('Missing required field: reason.', 'invalid_request');
    return;
  }
  const requestedTargetJid = validateSameChannelApprovalTarget({
    data,
    sourceAgentFolderJids,
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
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
      fallbackName: 'agent-created-skill',
      createdBy: `agent:${sourceAgentFolder}`,
      assets: parsed.assets,
    });
    const responder = { acceptData, reject };
    startSkillPermissionReview({
      deps,
      responder,
      service,
      syncApprovedCapabilitySettings,
      appId: data.appId as never,
      agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
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
  request_permission: { kind: 'Permission', required: [], any: ['capabilityId', 'toolName', 'toolNames', 'channelTool'], display: 'capabilityDisplayName', effect: 'review_only_no_permission_change' },
};

// prettier-ignore
const requestOnlyCapabilityHandler: TaskHandler = async (context) => {
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { accept, reject } = createContextTaskResponder(context);
  const toolName = data.type as RequestOnlyCapabilityToolName;
  const parsed = parseRequestOnlyCapabilityReview(toolName, data.payload || {});
  if (!parsed.ok) { reject(parsed.error, 'invalid_request'); return; }
  if (!data.appId) { reject(`${parsed.review.requestKind} requests require signed app scope.`, 'forbidden'); return; }
  const requestedTargetJid = validateSameChannelApprovalTarget({ data, sourceAgentFolderJids, requestKind: parsed.review.requestKind, reject });
  if (!requestedTargetJid) return;
  if (typeof deps.requestPermissionApproval !== 'function' || typeof deps.sendMessage !== 'function') { reject(`${parsed.review.requestKind} requests require a configured approval surface.`, 'preflight_failed'); return; }
  const jobConflict = await jobLocalCliCapabilityConflict({ deps, jobId: data.jobId, review: parsed.review });
  if (jobConflict) { reject(jobConflict, 'wrong_capability_lane'); return; }
  const pendingKey = requestOnlyCapabilityPendingKey({ data, sourceAgentFolder, targetJid: requestedTargetJid, review: parsed.review });
  if (pendingRequestOnlyCapabilityReviews.has(pendingKey)) { accept(`${parsed.review.displayName} request is already waiting for approval in this chat.`, 'capability_request_already_pending'); return; }
  pendingRequestOnlyCapabilityReviews.add(pendingKey);
  startRequestOnlyCapabilityReview({ deps, appId: data.appId as never, agentId: memoryAgentIdForGroupFolder(sourceAgentFolder) as never, sourceAgentFolder, targetJid: requestedTargetJid, threadId: data.authThreadId, ipcDir: context.ipcBaseDir ? path.join(context.ipcBaseDir, sourceAgentFolder) : undefined, runHandle: data.runHandle, review: parsed.review, pendingKey });
  accept(requestOnlyCapabilityQueuedMessage(parsed.review), 'capability_request_recorded');
};

// prettier-ignore
export const adminTaskHandlers: Record<string, TaskHandler> = { refresh_groups: refreshGroupsHandler, register_agent: registerAgentHandler, service_restart: serviceRestartHandler, settings_desired_state: settingsDesiredStateHandler, request_settings_update: requestSettingsUpdateHandler, request_skill_install: requestOnlyCapabilityHandler, request_skill_dependency_install: requestOnlyCapabilityHandler, request_permission: requestOnlyCapabilityHandler, request_skill_proposal: requestSkillDraftHandler, request_mcp_server: requestMcpServerHandler, mcp_list_tools: mcpListToolsHandler, mcp_call_tool: mcpCallToolHandler };

// prettier-ignore
function validateSameChannelApprovalTarget(input: { data: Parameters<TaskHandler>[0]['data']; sourceAgentFolderJids: string[]; requestKind: string; reject: (error: string, code?: string, details?: string[]) => void }): string | null {
  const requestedTargetJid = toTrimmedString(input.data.chatJid, { maxLen: 512 });
  const targetOverride = toTrimmedString(input.data.targetJid || input.data.jid, { maxLen: 512 });
  if (targetOverride && targetOverride !== requestedTargetJid) { input.reject(`${input.requestKind} requests must use the originating chat as the approval target.`, 'forbidden'); return null; }
  if (!requestedTargetJid || !input.sourceAgentFolderJids.includes(requestedTargetJid)) { input.reject(`${input.requestKind} requests must include the originating chat for this agent.`, 'forbidden'); return null; }
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
  if (toolName === 'request_permission' && isTemporaryBrowserPermissionRequest(payload)) return { ok: false, error: 'Browser cannot be approved as temporary current-run access through request_permission. Request persistent Browser access with temporaryOnly=false, then use the projected browser_* tools.' };
  if (toolName === 'request_permission' && isBrowserPermissionRequest(payload, isBrowserActionMcpToolRule)) return { ok: false, error: BROWSER_ACTION_MCP_RULE_REJECTION_REASON };
  if (toolName === 'request_permission' && isBrowserPermissionRequest(payload, isProjectedBrowserMcpToolRule)) return { ok: false, error: BROWSER_PROJECTED_MCP_RULE_REJECTION_REASON };
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
  if (toolName === 'request_permission') {
    const semanticError = validateRequestPermissionSemanticCapability(toolInput);
    if (semanticError) return { ok: false, error: semanticError };
  }
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
function isTemporaryBrowserPermissionRequest(payload: Record<string, unknown>): boolean {
  if (payload.temporaryOnly !== true) return false;
  if (payload.permissionKind && payload.permissionKind !== 'tool') return false;
  return sanitizedStringList([payload.toolName, ...(Array.isArray(payload.toolNames) ? payload.toolNames : [])]).some((toolName) => toolName === 'Browser');
}

// prettier-ignore
function isBrowserPermissionRequest(payload: Record<string, unknown>, predicate: (toolName: string) => boolean): boolean {
  if (payload.permissionKind && payload.permissionKind !== 'tool') return false;
  return sanitizedStringList([payload.toolName, ...(Array.isArray(payload.toolNames) ? payload.toolNames : [])]).some(predicate);
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
function startRequestOnlyCapabilityReview(input: { deps: Parameters<TaskHandler>[0]['deps']; appId: import('../domain/app/app.js').AppId; agentId: import('../domain/agent/agent.js').AgentId; sourceAgentFolder: string; targetJid: string; threadId?: string; ipcDir?: string; runHandle?: string; review: RequestOnlyCapabilityReview; pendingKey?: string }): void {
  void (async () => {
    let message: string;
    try {
      const requestId = `capability-${input.review.toolName}-${globalThis.crypto.randomUUID()}`;
      const decision = await input.deps.requestPermissionApproval({
        requestId,
        appId: input.appId,
        agentId: input.agentId,
        sourceAgentFolder: input.sourceAgentFolder,
        targetJid: input.targetJid,
        threadId: input.threadId,
        decisionPolicy: 'same_channel',
        toolName: input.review.toolName,
        displayName: input.review.displayName,
        title: `Approve ${input.review.requestKind.toLowerCase()} request`,
        description: input.review.toolName === 'request_permission' ? requestPermissionDescription() : 'Only configured approvers can decide this request. This records the permission review only and does not enable the capability directly.',
        decisionReason: input.review.reason,
        toolInput: input.review.toolInput,
        ...(semanticCapabilityInteraction(input.review, requestId)
          ? { interaction: semanticCapabilityInteraction(input.review, requestId) }
          : {}),
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
        persistedRules = await persistRequestPermissionRules({ deps: input.deps, appId: input.appId, agentId: input.agentId, sourceAgentFolder: input.sourceAgentFolder, ipcDir: input.ipcDir, runHandle: input.runHandle, requestId, updates: decision.updatedPermissions ?? [], toolInput: input.review.toolInput, actor: decision.decidedBy, conversationId: input.targetJid, threadId: input.threadId, reason: decision.reason });
      }
      message = decision.approved && decision.decidedBy
        ? persistedRules.length
          ? `Approved ${input.review.displayName}. Always allowed by ${decision.decidedBy}: ${formatPersistentPermissionRulesForUser(persistedRules)}.`
          : `Approved ${input.review.displayName}. Permission review recorded by ${decision.decidedBy}; no capability was enabled by this request-only flow.`
        : `Rejected ${input.review.displayName}: ${reason}. No capability was enabled.`;
    } catch (err) {
      logger.error(
        { err, sourceAgentFolder: input.sourceAgentFolder, toolName: input.review.toolName },
        'Capability permission review failed',
      );
      message = `Rejected ${input.review.displayName}: ${err instanceof Error ? err.message : 'permission review failed'}. No capability was enabled.`;
    }
    await input.deps.sendMessage(input.targetJid, message, input.threadId ? { threadId: input.threadId } : undefined);
  })()
    .catch((err) => logger.error({ err, sourceAgentFolder: input.sourceAgentFolder, toolName: input.review.toolName }, 'Capability permission review final message failed'))
    .finally(() => {
      if (input.pendingKey) pendingRequestOnlyCapabilityReviews.delete(input.pendingKey);
    });
}

function requestOnlyCapabilityPendingKey(input: {
  data: Parameters<TaskHandler>[0]['data'];
  sourceAgentFolder: string;
  targetJid: string;
  review: RequestOnlyCapabilityReview;
}): string {
  return JSON.stringify({
    toolName: input.review.toolName,
    appId: input.data.appId,
    agent: input.sourceAgentFolder,
    targetJid: input.targetJid,
    threadId: input.data.authThreadId ?? null,
    jobId: input.data.jobId ?? null,
    toolInput: input.review.toolInput,
  });
}

function semanticCapabilityInteraction(
  review: RequestOnlyCapabilityReview,
  requestId: string,
) {
  if (review.toolName !== 'request_permission') return undefined;
  const capabilityId = toTrimmedString(review.toolInput.capabilityId, {
    maxLen: 160,
  });
  if (!capabilityId) return undefined;
  const toolNames = sanitizedStringList([
    review.toolInput.toolName,
    ...(Array.isArray(review.toolInput.toolNames)
      ? review.toolInput.toolNames
      : []),
  ]);
  if (toolNames.length > 0) return undefined;
  const isLocalCliRequest = review.toolInput.credentialSource === 'local_cli';
  const displayName =
    toTrimmedString(review.toolInput.capabilityDisplayName, { maxLen: 200 }) ||
    (isLocalCliRequest
      ? undefined
      : getBuiltinSemanticCapability(capabilityId)?.displayName) ||
    capabilityId;
  return {
    id: requestId,
    title: `Allow ${displayName}?`,
    details: semanticCapabilityInteractionDetails(review.toolInput),
    requestContext: {
      requestId,
      capabilityId,
      capabilityDisplayName: displayName,
      toolName: review.toolName,
      capabilityType: String(review.toolInput.credentialSource || 'semantic'),
    },
  };
}

function semanticCapabilityInteractionDetails(
  toolInput: Record<string, unknown>,
) {
  const capabilityId = toTrimmedString(toolInput.capabilityId, {
    maxLen: 160,
  });
  const builtin = capabilityId
    ? getBuiltinSemanticCapability(capabilityId)
    : undefined;
  if (builtin && toolInput.credentialSource !== 'local_cli') {
    return [
      { label: 'Capability', value: `capability:${builtin.capabilityId}` },
      { label: 'Risk', value: builtin.risk },
      { label: 'Account', value: builtin.accountLabel ?? 'Configured account' },
      { label: 'Allows', value: builtin.can },
      { label: 'Does not allow', value: builtin.cannot },
    ];
  }
  return [
    detailFromToolInput(toolInput, 'Capability', 'capabilityId', 160),
    detailFromToolInput(toolInput, 'Account', 'accountLabel', 200),
    detailFromToolInput(toolInput, 'Allows', 'can', 1000),
    detailFromToolInput(toolInput, 'Does not allow', 'cannot', 1000),
  ].filter((detail): detail is { label: string; value: string } =>
    Boolean(detail),
  );
}

function detailFromToolInput(
  toolInput: Record<string, unknown>,
  label: string,
  key: string,
  maxLen: number,
): { label: string; value: string } | undefined {
  const value = toTrimmedString(toolInput[key], { maxLen });
  return value ? { label, value } : undefined;
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
function startMcpPermissionReview(input: { deps: Parameters<TaskHandler>[0]['deps']; responder: Pick<ReturnType<typeof createTaskResponder>, 'acceptData' | 'reject'>; service: McpServerService; appId: import('../domain/app/app.js').AppId; agentId: import('../domain/agent/agent.js').AgentId; sourceAgentFolder: string; targetJid: string; threadId?: string; server: { id: string; name: string }; transport: string; origin: string; requestedToolPatterns: string[]; credentialNeeds: string[]; reason: string }): void {
  void completeMcpPermissionReview(input).catch((err) => {
    logger.error(
      { err, serverId: input.server.id, sourceAgentFolder: input.sourceAgentFolder },
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
    appId: input.appId,
    agentId: input.agentId,
    sourceAgentFolder: input.sourceAgentFolder,
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

  let approvalApplied = false;
  try {
    await input.service.approveDraft({
      appId: input.appId,
      serverId: input.server.id as never,
      approvedBy: decision.decidedBy,
    });
    approvalApplied = true;
    await input.service.bindToAgent({
      appId: input.appId,
      agentId: input.agentId,
      serverId: input.server.id as never,
    });
    await syncApprovedCapabilitySettings(input.appId);
  } catch (err) {
    if (approvalApplied) {
      await input.service.rollbackApprovedBinding({
        appId: input.appId,
        agentId: input.agentId,
        serverId: input.server.id as never,
      });
    }
    throw err;
  }
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
    appId: input.appId,
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
  sourceAgentFolder: string,
  deps: Parameters<TaskHandler>[0]['deps'],
): Promise<McpToolProxy> {
  const storage = getRuntimeStorage();
  const credentials = await getHostRuntimeCredentialEnv(
    memoryAgentIdForGroupFolder(sourceAgentFolder),
    undefined,
    { purpose: 'tool_capability' },
  );
  return new McpToolProxy(storage.repositories.mcpServers, {
    credentialEnv: credentials.env,
    lookupHostname: deps.mcpHostnameLookup,
  });
}

async function syncApprovedCapabilitySettings(
  appId: import('../domain/app/app.js').AppId,
): Promise<void> {
  await syncRuntimeSettingsFromProjection({
    runtimeHome: MYCLAW_HOME,
    ops: getRuntimeRepositories(),
    repositories: getRuntimeStorage().repositories,
    appId,
  });
}
