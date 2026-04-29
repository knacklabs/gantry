import { MYCLAW_HOME } from '../config/index.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { McpServerService } from '../application/mcp/mcp-server-service.js';
import { SkillDraftService } from '../application/skills/skill-draft-service.js';
import { nowIso } from '../infrastructure/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { validateRuntimePreflightWithStorage } from '../config/preflight.js';
import { TaskHandler } from './ipc-types.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import {
  createTaskResponder,
  restartServiceForRuntimeHome,
  toTrimmedString,
} from './ipc-shared.js';
import { parseSkillDraftAssets } from './skill-draft-ipc.js';

const refreshGroupsHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
    reject('Only the main agent can refresh groups.', 'forbidden');
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
      new Set(Object.keys(registeredGroups)),
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
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized register_agent attempt blocked');
    reject('Only the main agent can register new agents.', 'forbidden');
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
    const existingGroup = registeredGroups[data.jid];
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

const serviceRestartHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain } = context;
  const taskId = toTrimmedString(data.taskId, { maxLen: 128 });
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    taskId,
    data.authThreadId,
  );
  if (!isMain) {
    logger.warn(
      { sourceGroup },
      'Unauthorized service_restart attempt blocked',
    );
    reject('Only the main agent can restart the service.', 'forbidden');
    return;
  }

  try {
    const validation = await validateRuntimePreflightWithStorage(MYCLAW_HOME);
    if (!validation.ok) {
      reject(
        validation.failure?.summary ||
          'Runtime configuration validation failed.',
        'preflight_failed',
        validation.failure?.details || [],
      );
      return;
    }

    accept('Service restart accepted. Restarting now.');

    setTimeout(() => {
      const restartOutcome = restartServiceForRuntimeHome(MYCLAW_HOME);
      if (!restartOutcome.ok) {
        logger.error(
          { sourceGroup, taskId, error: restartOutcome.message },
          'Service restart failed after acknowledgment',
        );
        return;
      }
      logger.info(
        { sourceGroup, taskId, message: restartOutcome.message },
        'Service restart completed',
      );
    }, 0);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : 'Service restart failed with an unexpected error.';
    logger.error(
      { sourceGroup, taskId, err },
      'Error while handling service_restart IPC task',
    );
    reject(message, 'internal_error');
  }
};

const requestMcpServerHandler: TaskHandler = async (context) => {
  const { data, deps, sourceGroup, sourceGroupJids } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const payload = data.payload || {};
  const name = toTrimmedString(payload.name, { maxLen: 80 });
  const transport = toTrimmedString(payload.transport, { maxLen: 32 });
  const origin = toTrimmedString(payload.origin, { maxLen: 2048 });
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 });
  if (!name || !reason) {
    reject('Missing required fields: name and reason.', 'invalid_request');
    return;
  }
  const requestedTargetJid = toTrimmedString(data.chatJid, { maxLen: 512 });
  const targetOverride = toTrimmedString(data.targetJid || data.jid, {
    maxLen: 512,
  });
  if (targetOverride && targetOverride !== requestedTargetJid) {
    reject(
      'MCP server requests must use the originating chat as the approval target.',
      'forbidden',
    );
    return;
  }
  if (!requestedTargetJid || !sourceGroupJids.includes(requestedTargetJid)) {
    reject(
      'MCP server requests must include the originating chat for this agent.',
      'forbidden',
    );
    return;
  }
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
    ? payload.requestedToolPatterns.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const credentialNeeds = Array.isArray(payload.credentialNeeds)
    ? payload.credentialNeeds.filter(
        (item): item is string => typeof item === 'string',
      )
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
    const created = await createOrReuseAgentMcpDraft({
      service,
      repository: storage.repositories.mcpServers,
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
    accept(
      `MCP server request ${created.definition.id} sent to this chat for approval. It will not be available until approved and will activate on the next agent run.`,
      'mcp_request_recorded',
    );
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'MCP server request failed.',
      'invalid_request',
    );
  }
};

const requestSkillDraftHandler: TaskHandler = async (context) => {
  const { data, deps, sourceGroup, sourceGroupJids } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const payload = data.payload || {};
  const reason = toTrimmedString(payload.reason, { maxLen: 2000 });
  if (!reason) {
    reject('Missing required field: reason.', 'invalid_request');
    return;
  }
  const requestedTargetJid = toTrimmedString(data.chatJid, { maxLen: 512 });
  const targetOverride = toTrimmedString(data.targetJid || data.jid, {
    maxLen: 512,
  });
  if (targetOverride && targetOverride !== requestedTargetJid) {
    reject(
      'Skill draft requests must use the originating chat as the approval target.',
      'forbidden',
    );
    return;
  }
  if (!requestedTargetJid || !sourceGroupJids.includes(requestedTargetJid)) {
    reject(
      'Skill draft requests must include the originating chat for this agent.',
      'forbidden',
    );
    return;
  }
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
    startSkillPermissionReview({
      deps,
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
      fileSummaries: parsed.fileSummaries,
      skillMarkdownPreview: parsed.skillMarkdownPreview,
      totalSizeBytes: parsed.totalSizeBytes,
      reason,
    });
    accept(
      `Skill draft ${draft.id} sent to this chat for approval. It will not be available until approved and will activate on the next agent run.`,
      'skill_request_recorded',
    );
  } catch (err) {
    reject(
      err instanceof Error ? err.message : 'Skill draft request failed.',
      'invalid_request',
    );
  }
};

export const adminTaskHandlers: Record<string, TaskHandler> = {
  refresh_groups: refreshGroupsHandler,
  register_agent: registerAgentHandler,
  service_restart: serviceRestartHandler,
  request_skill_draft: requestSkillDraftHandler,
  request_mcp_server: requestMcpServerHandler,
};

function credentialRefsForRequestedMcp(
  serverName: string,
  transport: string,
  credentialNeeds: string[],
) {
  if (transport === 'http' || transport === 'sse') {
    return credentialNeeds.map((ref, index) => ({
      name: brokerRefNameForAgentRequestedMcp(serverName, ref),
      target: 'header' as const,
      key:
        credentialNeeds.length === 1 && index === 0
          ? 'Authorization'
          : headerNameForCredentialNeed(ref),
    }));
  }
  return credentialNeeds.map((ref) => ({
    name: brokerRefNameForAgentRequestedMcp(serverName, ref),
    target: 'env' as const,
    key: headerNameForCredentialNeed(ref),
  }));
}

function brokerRefNameForAgentRequestedMcp(
  serverName: string,
  credentialNeed: string,
): string {
  const server = serverName.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const need = credentialNeed
    .replace(/_REF$/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_');
  return `MCP_${server}_${need}_REF`;
}

function headerNameForCredentialNeed(credentialNeed: string): string {
  return credentialNeed
    .replace(/_REF$/i, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

async function createOrReuseAgentMcpDraft(
  input: Parameters<McpServerService['createDraft']>[0] & {
    service: McpServerService;
    repository: ReturnType<
      typeof getRuntimeStorage
    >['repositories']['mcpServers'];
  },
) {
  const existing = await input.repository.getServerByName({
    appId: input.appId,
    name: input.name,
  });
  if (
    existing?.status === 'draft' &&
    existing.createdSource === 'agent_request'
  ) {
    const [version] = await input.repository.listVersions(existing.id);
    if (version) {
      return { definition: existing, version };
    }
  }
  return input.service.createDraft(input);
}

function startMcpPermissionReview(input: {
  deps: Parameters<TaskHandler>[0]['deps'];
  service: McpServerService;
  sourceGroup: string;
  targetJid: string;
  threadId?: string;
  server: { id: string; name: string };
  transport: string;
  origin: string;
  requestedToolPatterns: string[];
  credentialNeeds: string[];
  reason: string;
}): void {
  void completeMcpPermissionReview(input).catch((err) => {
    logger.error(
      { err, serverId: input.server.id, sourceGroup: input.sourceGroup },
      'MCP permission review failed',
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
      'Only configured approvers can decide this request. Approving installs this MCP server as an agent capability for future runs only.',
    decisionReason: input.reason,
    toolInput: {
      serverId: input.server.id,
      name: input.server.name,
      transport: input.transport,
      origin: input.origin,
      requestedToolPatterns: input.requestedToolPatterns,
      credentialNeeds: input.credentialNeeds,
      activation: 'next_agent_run',
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
  await input.deps.sendMessage(
    input.targetJid,
    `Approved MCP server ${input.server.name}. It will be available on the next agent run.`,
    input.threadId ? { threadId: input.threadId } : undefined,
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
}

function startSkillPermissionReview(input: {
  deps: Parameters<TaskHandler>[0]['deps'];
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
}): void {
  void completeSkillPermissionReview(input).catch((err) => {
    logger.error(
      { err, skillId: input.skill.id, sourceGroup: input.sourceGroup },
      'Skill permission review failed',
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
    toolName: 'request_skill_draft',
    displayName: `Skill: ${input.skill.name}`,
    title: 'Approve skill for this agent',
    description:
      'Only configured approvers can decide this request. Approving installs this skill as an agent capability for future runs only.',
    decisionReason: input.reason,
    toolInput: {
      skillId: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      packageContentHash: input.skill.contentHash,
      skillMarkdownPreview: input.skillMarkdownPreview,
      files: input.fileSummaries,
      totalSizeBytes: input.totalSizeBytes,
      activation: 'next_agent_run',
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
  await input.deps.sendMessage(
    input.targetJid,
    `Approved skill ${input.skill.name}. It will be available on the next agent run.`,
    input.threadId ? { threadId: input.threadId } : undefined,
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
}
