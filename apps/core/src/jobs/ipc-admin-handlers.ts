import path from 'path';
import { McpServerService } from '../application/mcp/mcp-server-service.js';
import { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import {
  getRuntimeRepositories,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  GANTRY_HOME,
  getRuntimeSettingsForConfig,
  syncRuntimeSettingsFromProjection,
} from '../config/index.js';
import { parseDeclaredNetworkHost } from '../shared/network-host-declaration.js';
import { nowIso } from '../shared/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { TaskContext, TaskHandler } from './ipc-types.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { resolveMcpCredentialEnvForAgent } from '../application/capability-secrets/mcp-secret-projection.js';
import {
  isPermanentPermissionDecision,
  formatDurableAccessRulesForUser,
  pendingAccessTargetSummary,
  persistRequestPermissionRules,
  requestPermissionDescription,
  requestPermissionOnceLiveRules,
  requestPermissionQueuedMessage,
  requestPermissionReviewEffect,
  requestPermissionReviewSuggestions,
  requestPermissionSetupDecisionOptions,
  resolveTrustedSemanticCapabilityDefinitions,
  validateRequestPermissionCapabilityProposal,
  validateRequestPermissionSemanticCapability,
} from './request-permission-review.js';
import {
  guidedActionPreviewHandler,
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
import { semanticCapabilityFromToolCatalogItem } from '../shared/semantic-capabilities.js';
import { PermissionManagementService } from '../application/permissions/permission-management-service.js';
import { skillActionDefinitionsForAgent } from '../application/agents/agent-capability-skill-actions.js';
import {
  formatApprovalRequestedMessage,
  formatNotApprovedMessage,
} from '../shared/user-visible-messages.js';
import { jobLocalCliCapabilityConflict } from './ipc-request-permission-local-cli.js';
import { maybeEnqueueApprovedDependencyBake } from './toolchain-bake-bootstrap.js';
import {
  configureSkillInstallHandlers,
  requestSkillInstallHandler,
  requestSkillProposalHandler,
} from './ipc-skill-install-handlers.js';
import {
  configurePatternCandidateIpcHandlers,
  patternCandidateDecisionHandler,
} from './pattern-candidate-ipc-handlers.js';
import {
  configureProactiveSurfacingConsentIpcHandlers,
  proactiveSurfacingConsentHandler,
} from './proactive-surfacing-consent-ipc-handlers.js';
import {
  credentialRefsForRequestedMcp,
  headerNameForCredentialNeed,
} from './ipc-mcp-server-request-credentials.js';
import { createMcpToolHandlers } from './ipc-mcp-tool-handlers.js';
import { semanticCapabilityInteraction } from './ipc-semantic-capability-interaction.js';
import {
  appendLiveToolRules,
  readLiveToolRules,
} from '../shared/live-tool-rules.js';
import {
  formatRequestAccessPersistentGrantMessage,
  recheckPausedSetupJobsAfterRequestAccessGrant,
} from './request-access-job-recovery.js';
import { requestOnlyCapabilityPendingKey } from './request-only-capability-dedupe.js';
const pendingRequestOnlyCapabilityReviews = new Set<string>();
const {
  asyncMcpCallToolHandler,
  mcpCallToolHandler,
  mcpDescribeToolHandler,
  mcpListToolsHandler,
} = createMcpToolHandlers(createMcpProxyForSourceGroup);
configureSkillInstallHandlers({
  getStorage: getRuntimeStorage,
  logInfo: (context, message) => logger.info(context, message),
  logError: (context, message) => logger.error(context, message),
  syncApprovedCapabilitySettings,
});
configurePatternCandidateIpcHandlers({
  getStorage: getRuntimeStorage,
});
configureProactiveSurfacingConsentIpcHandlers({
  getStorage: getRuntimeStorage,
});
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
      'I could not refresh the conversation list. Explain this in plain language and say you can try again after the sync issue is fixed.',
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
  if (!isValidWorkspaceFolder(data.folder)) { logger.warn({ sourceAgentFolder, folder: data.folder }, 'Invalid register_agent request - unsafe folder name'); reject(`Invalid agent folder: ${data.folder}`, 'invalid_request'); return; }
  const reason = toTrimmedString(data.payload?.reason, { maxLen: 2000 }) || `Register ${data.name} for ${data.jid}.`;
  const decision = await deps.requestPermissionApproval({
    requestId: `register-agent-${globalThis.crypto.randomUUID()}`,
    appId: data.appId as never,
    agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
    sourceAgentFolder,
    targetJid: requestedTargetJid,
    threadId: data.authThreadId,
    decisionPolicy: 'same_channel',
    decisionOptions: ['allow_once', 'cancel'],
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
  const payload = data.payload || {};
  if (!data.appId) {
    reject('MCP server requests require signed app scope.', 'forbidden');
    return;
  }
  const name = toTrimmedString(payload.name, { maxLen: 80 });
  const transport = toTrimmedString(payload.transport, { maxLen: 32 });
  const templateId = toTrimmedString(payload.templateId, { maxLen: 80 });
  const sandboxProfileId = toTrimmedString(payload.sandboxProfileId, {
    maxLen: 120,
  });
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 }) || '';
  if (!name || !reason) {
    reject('Missing required fields: name and reason.', 'invalid_request');
    return;
  }
  // prettier-ignore
  const requestedTargetJid = validateSameChannelApprovalTarget({ data, sourceAgentFolderJids, requestKind: 'MCP server', reject });
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
  if (transport !== 'stdio_template') {
    reject(
      'request_mcp_server supports only stdio_template servers until Gantry has a DNS-pinned remote MCP transport.',
      'invalid_request',
    );
    return;
  }
  if (!templateId || !sandboxProfileId) {
    reject(
      'stdio_template MCP server requests require templateId and sandboxProfileId.',
      'invalid_request',
    );
    return;
  }
  const args = Array.isArray(payload.args)
    ? payload.args
        .map((item) => toTrimmedString(item, { maxLen: 240 }))
        .filter((item): item is string => Boolean(item))
    : [];
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
  const networkHosts: string[] = [];
  if (Array.isArray(payload.networkHosts)) {
    for (const item of payload.networkHosts) {
      const raw = toTrimmedString(item, { maxLen: 160 });
      if (!raw) continue;
      const result = parseDeclaredNetworkHost(raw);
      if (!result.ok) {
        reject(`MCP server networkHosts ${result.reason}`, 'invalid_request');
        return;
      }
      if (!networkHosts.includes(result.host)) networkHosts.push(result.host);
    }
  }
  const storage = getRuntimeStorage();
  // prettier-ignore
  const service = new McpServerService(storage.repositories.mcpServers, undefined, { lookupHostname: deps.mcpHostnameLookup });
  try {
    const config = {
      transport,
      templateId,
      ...(args.length > 0 ? { args } : {}),
    };
    const credentialRefs = credentialRefsForRequestedMcp(
      name,
      transport,
      credentialNeeds,
    );
    startMcpPermissionReview({
      deps,
      responder: { acceptData, reject },
      service,
      appId: data.appId as never,
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      targetJid: requestedTargetJid,
      threadId: data.authThreadId,
      server: { name },
      transport,
      sandboxProfileId,
      transportConfig: config as never,
      origin: '',
      requestedToolPatterns,
      credentialRefs,
      credentialNeeds,
      networkHosts,
      reason,
    });
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'MCP server request failed unexpectedly',
    );
    reject(
      'The MCP server request could not be completed. Explain this in plain language and say you can try again after the setup issue is fixed.',
      'invalid_request',
    );
  }
};
// prettier-ignore
type RequestOnlyCapabilityToolName = 'request_skill_dependency_install' | 'request_permission';
// prettier-ignore
interface RequestOnlyCapabilityReview { toolName: RequestOnlyCapabilityToolName; requestKind: string; displayName: string; reason: string; toolInput: Record<string, unknown>; }
// prettier-ignore
const requestOnlyCapabilitySpecs: Record<RequestOnlyCapabilityToolName, { kind: string; required: string[]; any?: string[]; display: string; effect: string }> = {
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
  const catalogConflict = await missingReviewedCapabilityCatalogEntry({ deps, appId: data.appId as string, agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder), review: parsed.review });
  if (catalogConflict) { reject(catalogConflict, 'invalid_request'); return; }
  const pendingKey = requestOnlyCapabilityPendingKey({ data, sourceAgentFolder, targetJid: requestedTargetJid, review: parsed.review });
  if (pendingRequestOnlyCapabilityReviews.has(pendingKey)) { accept(`${parsed.review.displayName} request is already waiting for approval in this chat.`, 'capability_request_already_pending'); return; }
  pendingRequestOnlyCapabilityReviews.add(pendingKey);
  startRequestOnlyCapabilityReview({ deps, appId: data.appId as never, agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never, sourceAgentFolder, targetJid: requestedTargetJid, threadId: data.authThreadId, ipcDir: context.ipcBaseDir ? path.join(context.ipcBaseDir, sourceAgentFolder) : undefined, runHandle: data.runHandle, jobId: data.jobId, review: parsed.review, pendingKey });
  accept(requestOnlyCapabilityQueuedMessage(parsed.review), 'capability_request_recorded');
};
async function missingReviewedCapabilityCatalogEntry(input: {
  deps: TaskContext['deps'];
  appId: string;
  agentId: string;
  review: RequestOnlyCapabilityReview;
}): Promise<string | undefined> {
  if (input.review.toolName !== 'request_permission') return undefined;
  const capabilityId = toTrimmedString(input.review.toolInput.capabilityId, {
    maxLen: 160,
  });
  if (!capabilityId) return undefined;
  const toolNames = sanitizedStringList([
    input.review.toolInput.toolName,
    ...(Array.isArray(input.review.toolInput.toolNames)
      ? input.review.toolInput.toolNames
      : []),
  ]);
  if (toolNames.length > 0) return undefined;
  const repository = input.deps.getToolRepository?.();
  if (repository && typeof repository.listTools === 'function') {
    const activeTools = await repository.listTools({
      appId: input.appId as never,
      statuses: ['active'],
    });
    const matched = activeTools.some((tool) => {
      if (tool.status !== 'active' || !tool.selectable) return false;
      const capability = semanticCapabilityFromToolCatalogItem({
        name: tool.name,
        inputSchema: tool.inputSchema,
      });
      return capability?.capabilityId === capabilityId;
    });
    if (matched) return undefined;
  }
  const skillRepository = input.deps.getSkillRepository?.();
  if (skillRepository) {
    const skillCapabilities = await skillActionDefinitionsForAgent({
      appId: input.appId as never,
      agentId: input.agentId as never,
      skillRepository,
    });
    if (skillCapabilities[capabilityId]) return undefined;
  }
  return 'Capability access requires an active reviewed capability catalog entry. Request the reviewed capability with request_access target.kind=capability.';
}
// prettier-ignore
const adminPermissionRevokeHandler: TaskHandler = async (context) => {
  const { data, deps, sourceAgentFolder, sourceAgentFolderJids } = context;
  const { acceptData, reject } = createContextTaskResponder(context);
  if (!data.appId) { reject('Permission revoke requires signed app scope.', 'forbidden'); return; }
  if (!(await sourceAgentHasAdminToolCapability(context, 'admin_permission_revoke'))) { logger.warn({ sourceAgentFolder }, 'Unauthorized admin_permission_revoke attempt blocked'); reject(adminCapabilityRequiredMessage('admin_permission_revoke'), 'missing_capability'); return; }
  const requestedTargetJid = validateSameChannelApprovalTarget({ data, sourceAgentFolderJids, requestKind: 'Permission revoke', reject });
  if (!requestedTargetJid) return;
  const payload = data.payload || {};
  const toolName = toTrimmedString(payload.toolName ?? payload.tool_name, { maxLen: 512 });
  const toolId = toTrimmedString(payload.toolId ?? payload.tool_id, { maxLen: 512 });
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 });
  if (!toolName && !toolId) { reject('admin_permission_revoke requires tool_name or tool_id.', 'invalid_request'); return; }
  if (!reason) { reject('admin_permission_revoke requires reason.', 'invalid_request'); return; }
  const toolRepository = deps.getToolRepository?.();
  const mirrorAgentToolRulesToSettings = deps.mirrorAgentToolRulesToSettings;
  if (!toolRepository || !mirrorAgentToolRulesToSettings) { reject('Permission revoke requires tool repository and settings mirror.', 'preflight_failed'); return; }
  try {
    const revoked = await new PermissionManagementService().revokePersistentToolRuleGrant({
      appId: data.appId as never,
      agentId: memoryAgentIdForWorkspaceFolder(sourceAgentFolder) as never,
      sourceAgentFolder,
      toolRepository,
      mirrorAgentToolRulesToSettings,
      permissionRepository: deps.getPermissionRepository?.(),
      ipcDir: context.ipcBaseDir ? path.join(context.ipcBaseDir, sourceAgentFolder) : undefined,
      runHandle: data.runHandle,
      requestId: data.taskId ? `admin-permission-revoke:${data.taskId}` : undefined,
      actor: `agent:${sourceAgentFolder}`,
      conversationId: requestedTargetJid,
      threadId: data.authThreadId,
      reason,
      toolName,
      toolId,
    });
    acceptData(`Revoked ${revoked.revokedRule} for this agent. settings.yaml and live-run approval state were updated.`, { revokedRule: revoked.revokedRule, toolId: revoked.toolId }, 'permission_revoked');
  } catch (err) {
    reject(err instanceof Error ? err.message : 'Permission revoke failed.', 'permission_revoke_failed');
  }
};
// prettier-ignore
export const adminTaskHandlers: Record<string, TaskHandler> = { refresh_groups: refreshGroupsHandler, register_agent: registerAgentHandler, service_restart: serviceRestartHandler, settings_desired_state: settingsDesiredStateHandler, guided_action_preview: guidedActionPreviewHandler, request_settings_update: requestSettingsUpdateHandler, admin_permission_revoke: adminPermissionRevokeHandler, request_skill_install: requestSkillInstallHandler, request_skill_dependency_install: requestOnlyCapabilityHandler, request_permission: requestOnlyCapabilityHandler, request_skill_proposal: requestSkillProposalHandler, pattern_candidate_decision: patternCandidateDecisionHandler, proactive_surfacing_consent: proactiveSurfacingConsentHandler, request_mcp_server: requestMcpServerHandler, mcp_list_tools: mcpListToolsHandler, mcp_describe_tool: mcpDescribeToolHandler, mcp_call_tool: mcpCallToolHandler, async_mcp_call: asyncMcpCallToolHandler };
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
  if (toolName === 'request_permission' && hasAgentSuppliedCapabilityDefinition(payload)) return { ok: false, error: 'Capability definitions are host-owned catalog metadata and cannot be supplied in request_permission input.' };
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
    const capabilityId = toTrimmedString(payload.capabilityId, { maxLen: 160 });
    const toolNames = sanitizedStringList([
      payload.toolName,
      ...(Array.isArray(payload.toolNames) ? payload.toolNames : []),
    ]);
    const capabilityProposalError = validateRequestPermissionCapabilityProposal({ capabilityId, toolNames, capabilityRequestSource: payload.capabilityRequestSource, toolInput });
    if (capabilityProposalError) return { ok: false, error: capabilityProposalError };
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
  return toolName === 'request_permission' ? requestPermissionReviewEffect(toolInput, fallback) : fallback;
}
// prettier-ignore
function requestOnlyCapabilityQueuedMessage(review: RequestOnlyCapabilityReview): string {
  return review.toolName === 'request_permission' ? requestPermissionQueuedMessage({ toolName: 'request_permission', displayName: review.displayName }) : `${formatApprovalRequestedMessage(review.displayName)} Admin setup may still be needed after approval.`;
}
// prettier-ignore
function payloadHasValue(value: unknown): boolean { return Array.isArray(value) ? value.some((item) => Boolean(toTrimmedString(item, { maxLen: 300 }))) : Boolean(toTrimmedString(value, { maxLen: 512 })); }
// prettier-ignore
function sanitizeCapabilityPayload(payload: Record<string, unknown>) {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'reason') continue;
    if (key === 'semanticCapabilityDefinition' || key === 'capabilityDefinition') continue;
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
function startRequestOnlyCapabilityReview(input: { deps: Parameters<TaskHandler>[0]['deps']; appId: import('../domain/app/app.js').AppId; agentId: import('../domain/agent/agent.js').AgentId; sourceAgentFolder: string; targetJid: string; threadId?: string; ipcDir?: string; runHandle?: string; jobId?: string; review: RequestOnlyCapabilityReview; pendingKey?: string }): void {
  void (async () => {
    let message: string;
    const requestId = `capability-${input.review.toolName}-${globalThis.crypto.randomUUID()}`;
    try {
      try {
        await getRuntimeStorage().repositories.pendingAccessRequests.insertPending({
          id: requestId,
          appId: input.appId,
          agentId: input.agentId,
          requestedBy: input.sourceAgentFolder,
          target: pendingAccessTargetSummary(input.review),
        });
      } catch (err) {
        logger.warn({ err, requestId }, 'Failed to record pending access request');
      }
      const semanticCapabilityDefinitions =
        await resolveTrustedSemanticCapabilityDefinitions({
          deps: input.deps,
          appId: input.appId,
          agentId: input.agentId,
        });
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
        description: input.review.toolName === 'request_permission' ? requestPermissionDescription() : 'Only configured approvers can decide this request. Approval records the admin decision; setup may still require a host admin.',
        decisionReason: input.review.reason,
        toolInput: input.review.toolInput,
        ...(semanticCapabilityDefinitions ? { semanticCapabilityDefinitions } : {}),
        ...(semanticCapabilityInteraction(input.review, requestId)
          ? { interaction: semanticCapabilityInteraction(input.review, requestId) }
          : {}),
        ...(input.review.toolName === 'request_permission'
          ? {
              suggestions: requestPermissionReviewSuggestions(
                input.review.toolInput,
                { semanticCapabilityDefinitions },
              ),
              decisionOptions: requestPermissionSetupDecisionOptions(
                input.review.toolInput,
                { semanticCapabilityDefinitions },
              ),
            }
          : {}),
      });
      const reason = decision.approved ? 'missing approving principal' : decision.reason || 'not approved';
      let persistedRules: string[] = [];
      let liveRules: string[] = [];
      if (input.review.toolName === 'request_permission' && isPermanentPermissionDecision(decision)) {
        persistedRules = await persistRequestPermissionRules({ deps: input.deps, appId: input.appId, agentId: input.agentId, sourceAgentFolder: input.sourceAgentFolder, ipcDir: input.ipcDir, runHandle: input.runHandle, requestId, updates: decision.updatedPermissions ?? [], toolInput: input.review.toolInput, semanticCapabilityDefinitions, actor: decision.decidedBy, conversationId: input.targetJid, threadId: input.threadId, jobId: input.jobId, reason: decision.reason });
      }
      const recovery = persistedRules.length > 0 ? await recheckPausedSetupJobsAfterRequestAccessGrant({ deps: input.deps, appId: input.appId, sourceAgentFolder: input.sourceAgentFolder, targetJid: input.targetJid, jobId: input.jobId, logWarn: (context, message) => logger.warn(context, message) }) : undefined;
      const transientRules = input.review.toolName === 'request_permission' && decision.approved && decision.decidedBy && decision.mode === 'allow_once' ? requestPermissionOnceLiveRules(input.review.toolInput, semanticCapabilityDefinitions) : [];
      if (transientRules.length > 0) liveRules = appendLiveToolRules({ ipcDir: input.ipcDir, runHandle: input.runHandle, rules: transientRules });
      try {
        await getRuntimeStorage().repositories.pendingAccessRequests.markResolved({
          appId: input.appId,
          id: requestId,
          resolution: decision.approved && decision.decidedBy ? 'approved' : 'denied',
        });
      } catch (err) {
        logger.warn({ err, requestId }, 'Failed to resolve pending access request');
      }
      const bakeMessage =
        decision.approved && decision.decidedBy
          ? await maybeEnqueueDependencyBakeOnApproval({
              review: input.review,
              appId: input.appId,
              agentId: input.agentId,
              conversationId: input.targetJid,
            })
          : null;
      message = decision.approved && decision.decidedBy
        ? bakeMessage
          ? bakeMessage
          : persistedRules.length
          ? formatRequestAccessPersistentGrantMessage({ displayName: input.review.displayName, rules: persistedRules, semanticCapabilityDefinitions, recovery })
          : liveRules.length
            ? `Allowed ${input.review.displayName} for this run. Details: ${formatDurableAccessRulesForUser(liveRules)}.`
          : `Approved ${input.review.displayName}. Admin setup may still be needed before it can be used.`
        : `Not approved: ${input.review.displayName}. Reason: ${reason}.`;
    } catch (err) {
      logger.error(
        { err, sourceAgentFolder: input.sourceAgentFolder, toolName: input.review.toolName },
        'Capability permission review failed',
      );
      message =
        'I could not finish that setup request. I left the current setup unchanged; try again after the setup issue is fixed.';
      try {
        await getRuntimeStorage().repositories.pendingAccessRequests.markResolved({
          appId: input.appId,
          id: requestId,
          resolution: 'denied',
        });
      } catch (markErr) {
        logger.warn({ err: markErr, requestId }, 'Failed to resolve pending access request');
      }
    }
    await input.deps.sendMessage(input.targetJid, message, input.threadId ? { threadId: input.threadId } : undefined);
  })()
    .catch((err) => logger.error({ err, sourceAgentFolder: input.sourceAgentFolder, toolName: input.review.toolName }, 'Capability permission review final message failed'))
    .finally(() => {
      if (input.pendingKey) pendingRequestOnlyCapabilityReviews.delete(input.pendingKey);
    });
}
/**
 * In fleet mode, an approved npm `request_skill_dependency_install` enqueues a
 * sandboxed toolchain bake instead of installing locally (ADR
 * capability-artifacts). Returns the user-facing approval message when a bake
 * was enqueued/deduplicated, or null to fall through to the default approval
 * message (workstation mode, non-npm ecosystems, or when no packages are given).
 */
async function maybeEnqueueDependencyBakeOnApproval(input: {
  review: RequestOnlyCapabilityReview;
  appId: import('../domain/app/app.js').AppId;
  agentId: import('../domain/agent/agent.js').AgentId;
  conversationId: string;
}): Promise<string | null> {
  if (input.review.toolName !== 'request_skill_dependency_install') return null;
  const ecosystem = toTrimmedString(input.review.toolInput.ecosystem, {
    maxLen: 64,
  });
  if (ecosystem !== 'npm') return null;
  const packages = sanitizedStringList(
    Array.isArray(input.review.toolInput.packages)
      ? input.review.toolInput.packages
      : [],
  );
  if (packages.length === 0) return null;
  try {
    const result = await maybeEnqueueApprovedDependencyBake({
      appId: input.appId,
      packages,
      requestedByAgentId: input.agentId,
      approvedByConversationId: input.conversationId,
      approvedAt: nowIso(),
    });
    if (!result) return null;
    const names = packages.join(', ');
    return result.deduplicated
      ? `Approved ${input.review.displayName}. A toolchain bake for ${names} is already in progress for this fleet; it will be available on workers once activated.`
      : `Approved ${input.review.displayName}. Queued a sandboxed toolchain bake for ${names}; it will be available on workers once baked and activated.`;
  } catch (err) {
    logger.warn(
      { err, appId: input.appId },
      'Failed to enqueue approved toolchain bake',
    );
    return `Approved ${input.review.displayName}, but I could not queue the setup. I left it unavailable; try again after the setup issue is fixed.`;
  }
}
function hasAgentSuppliedCapabilityDefinition(
  payload: Record<string, unknown>,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(
      payload,
      'semanticCapabilityDefinition',
    ) || Object.prototype.hasOwnProperty.call(payload, 'capabilityDefinition')
  );
}
// prettier-ignore
function startMcpPermissionReview(input: { deps: Parameters<TaskHandler>[0]['deps']; responder: Pick<ReturnType<typeof createTaskResponder>, 'acceptData' | 'reject'>; service: McpServerService; appId: import('../domain/app/app.js').AppId; agentId: import('../domain/agent/agent.js').AgentId; sourceAgentFolder: string; targetJid: string; threadId?: string; server: { name: string }; transport: string; sandboxProfileId?: string; transportConfig: import('../domain/mcp/mcp-servers.js').McpServerTransportConfig; origin: string; requestedToolPatterns: string[]; credentialRefs: import('../domain/mcp/mcp-servers.js').McpCredentialRef[]; credentialNeeds: string[]; networkHosts: string[]; reason: string }): void {
  void completeMcpPermissionReview(input).catch((err) => {
    logger.error(
      { err, serverName: input.server.name, sourceAgentFolder: input.sourceAgentFolder },
      'MCP source review failed',
    );
    input.responder.reject(
      'The MCP server request could not be completed. Explain this in plain language and say you can try again after the setup issue is fixed.',
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
    decisionOptions: ['allow_once', 'cancel'],
    toolName: 'request_mcp_server',
    displayName: `MCP server: ${input.server.name}`,
    title: 'Connect MCP source for this agent',
    description:
      'Only configured approvers can decide this request. Approval records this service as an agent source through the Gantry MCP proxy; durable action authority still requires an agent allowed capability selected from a reviewed definition.',
    decisionReason: input.reason,
    toolInput: {
      name: input.server.name,
      transport: input.transport,
      sandboxProfileId: input.sandboxProfileId,
      origin: input.origin,
      requestedToolPatterns: input.requestedToolPatterns,
      credentialNeeds: input.credentialNeeds,
      networkHosts: input.networkHosts,
      activation: 'source_inventory_only',
    },
  });
  if (!decision.approved) {
    await rejectMcpRequestFromPermission(input, decision.reason);
    return;
  }
  if (!decision.decidedBy) {
    await rejectMcpRequestFromPermission(input, 'missing approving principal');
    return;
  }
  let connectedServerId: string | undefined;
  try {
    const server = await input.service.connectServer({
      appId: input.appId,
      name: input.server.name,
      createdBy: decision.decidedBy,
      createdSource: 'agent_request',
      requestedReason: input.reason,
      transportConfig: input.transportConfig,
      allowedToolPatterns: input.requestedToolPatterns,
      credentialRefs: input.credentialRefs,
      networkHosts: input.networkHosts,
      sandboxProfileId: input.sandboxProfileId,
      riskClass: 'medium',
    });
    connectedServerId = server.id;
    await input.service.bindToAgent({
      appId: input.appId,
      agentId: input.agentId,
      serverId: server.id,
    });
    await syncApprovedCapabilitySettings(input.appId);
  } catch (err) {
    if (connectedServerId) {
      await input.service.rollbackConnectedServer({
        appId: input.appId,
        agentId: input.agentId,
        serverId: connectedServerId as never,
      });
    }
    throw err;
  }
  const sameSessionContext = {
    type: 'connected_mcp_context',
    activation: 'source_inventory_only',
    server: {
      id: connectedServerId,
      name: input.server.name,
      transport: input.transport,
      origin: input.origin,
    },
    availableToolNames: input.requestedToolPatterns,
    currentSessionUsage: {
      listToolsTool: 'mcp__gantry__mcp_list_tools',
      requestAccessTool: 'mcp__gantry__request_access',
      serverName: input.server.name,
    },
  };
  await input.deps.sendMessage(
    input.targetJid,
    `Connected MCP source ${input.server.name}. Review a capability before using durable MCP actions.`,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.acceptData(
    `Connected MCP source ${input.server.name}. Review a capability before using durable MCP actions.`,
    sameSessionContext,
    'mcp_connected',
  );
}
async function rejectMcpRequestFromPermission(
  input: Parameters<typeof startMcpPermissionReview>[0],
  reason?: string,
): Promise<void> {
  const message = formatNotApprovedMessage({
    action: 'connect',
    noun: 'MCP server',
    name: input.server.name,
    reason,
  });
  await input.deps.sendMessage(
    input.targetJid,
    message,
    input.threadId ? { threadId: input.threadId } : undefined,
  );
  input.responder.reject(message, 'permission_denied');
}
async function createMcpProxyForSourceGroup(input: {
  appId: import('../domain/app/app.js').AppId;
  agentId: import('../domain/agent/agent.js').AgentId;
  deps: Parameters<TaskHandler>[0]['deps'];
  ipcDir?: string;
  runHandle?: string;
  runId?: string;
}): Promise<McpToolProxy> {
  const storage = getRuntimeStorage();
  const credentialEnv = await resolveMcpCredentialEnvForAgent({
    appId: input.appId,
    agentId: input.agentId,
    mcpServers: storage.repositories.mcpServers,
    secrets:
      input.deps.getCapabilitySecretRepository?.() ??
      storage.repositories.capabilitySecrets,
  });
  return new McpToolProxy(storage.repositories.mcpServers, {
    tools: storage.repositories.tools,
    skills: storage.repositories.skills,
    credentialEnv,
    liveToolRules: readLiveToolRules({
      ipcDir: input.ipcDir,
      runHandle: input.runHandle,
    }),
    lookupHostname: input.deps.mcpHostnameLookup,
    egressDenylist: getRuntimeSettingsForConfig().permissions.egress.denylist,
    publishRuntimeEvent: input.deps.publishRuntimeEvent,
    runId: input.runId,
    runHandle: input.runHandle,
  });
}
async function syncApprovedCapabilitySettings(
  appId: import('../domain/app/app.js').AppId,
): Promise<void> {
  const storage = getRuntimeStorage();
  await syncRuntimeSettingsFromProjection({
    runtimeHome: GANTRY_HOME,
    ops: getRuntimeRepositories(),
    repositories: storage.repositories,
    settingsRevisions: storage.repositories.settingsRevisions,
    pool: storage.service?.pool,
    createdBy: 'capability-approval:projection-sync',
    appId,
  });
}
