import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME as DEFAULT_ASSISTANT_NAME } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { ConversationRoute, ThinkingOverride } from '../domain/types.js';
import {
  resolveModelAlias,
  resolveModelSelectionForWorkload,
} from '../shared/model-catalog.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import {
  profileFileMirrorExists,
  writeProfileFileMirror,
} from '../platform/profile-file-mirror.js';
import { AvailableGroup } from './agent-spawn.js';
import { PromptProfileService } from '../application/agents/prompt-profile-service.js';
import { resolveAgentLockStatus } from '../config/profiles.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';

interface ChatRow {
  jid: string;
  name: string | null;
  last_message_time: string;
  is_group: boolean | number;
}

interface RegisterGroupOptions {
  assistantName?: string;
  persist: (jid: string, group: ConversationRoute) => void | Promise<void>;
  ensureCredentialBinding: (jid: string, group: ConversationRoute) => void;
  getFileArtifactStore?: () => FileArtifactStore | undefined;
}

interface EnsureRouteProfileDefaultsOptions {
  assistantName?: string;
  getFileArtifactStore?: () => FileArtifactStore | undefined;
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function commitGroupOverride(
  conversationRoutes: Record<string, ConversationRoute>,
  chatJid: string,
  updatedGroup: ConversationRoute,
  persisted: void | Promise<void>,
  logContext: Record<string, unknown>,
  logMessage: string,
): void | Promise<void> {
  const commit = () => {
    conversationRoutes[chatJid] = updatedGroup;
    logger.info(logContext, logMessage);
  };
  if (isPromiseLike(persisted)) {
    return persisted.then(commit);
  }
  commit();
}

export async function ensureRouteProfileDefaults(
  routes: Iterable<ConversationRoute>,
  options: EnsureRouteProfileDefaultsOptions = {},
): Promise<number> {
  const seenFolders = new Set<string>();
  const profileService = new PromptProfileService({
    fileArtifactStore: () => options.getFileArtifactStore?.(),
    mirrorProfileFile: writeProfileFileMirror,
    mirrorFileExists: profileFileMirrorExists,
  });
  for (const route of routes) {
    const folder = route.folder;
    if (seenFolders.has(folder)) continue;
    seenFolders.add(folder);
    await profileService.ensureAgentDefaults({
      agentFolder: folder,
      agentName: options.assistantName ?? route.name,
      relationshipMode: route.agentConfig?.relationshipMode,
      accessPreset:
        resolveAgentLockStatus(folder) === 'locked' ? 'locked' : 'full',
    });
  }
  return seenFolders.size;
}

export async function registerGroup(
  conversationRoutes: Record<string, ConversationRoute>,
  jid: string,
  group: ConversationRoute,
  options: RegisterGroupOptions,
): Promise<void> {
  const assistantName = options.assistantName ?? DEFAULT_ASSISTANT_NAME;

  let groupDir: string;
  try {
    groupDir = resolveWorkspaceFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  await ensureRouteProfileDefaults([group], {
    assistantName,
    getFileArtifactStore: options.getFileArtifactStore,
  });

  conversationRoutes[jid] = group;
  await options.persist(jid, group);
  options.ensureCredentialBinding(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

export function setGroupModelOverride(
  conversationRoutes: Record<string, ConversationRoute>,
  chatJid: string,
  model: string | undefined,
  persist: (jid: string, group: ConversationRoute) => void | Promise<void>,
): Promise<void> | void {
  const existingGroup = conversationRoutes[chatJid];
  if (!existingGroup) return;

  const trimmedModel = typeof model === 'string' ? model.trim() : '';
  if (trimmedModel) {
    const resolved = resolveModelSelectionForWorkload(trimmedModel, 'chat');
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }
  }
  const normalizedModel = resolveModelAlias(model);
  const prevModel = existingGroup.agentConfig?.model;
  if (prevModel === normalizedModel) return;

  const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
  if (normalizedModel) {
    nextAgentConfig.model = normalizedModel;
  } else {
    delete nextAgentConfig.model;
  }

  const updatedGroup: ConversationRoute = {
    ...existingGroup,
    agentConfig:
      Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
  };

  const persisted = persist(chatJid, updatedGroup);
  return commitGroupOverride(
    conversationRoutes,
    chatJid,
    updatedGroup,
    persisted,
    {
      group: updatedGroup.name,
      modelOverride: normalizedModel ?? null,
    },
    'Updated group model override',
  );
}

export function setGroupThinkingOverride(
  conversationRoutes: Record<string, ConversationRoute>,
  chatJid: string,
  thinking: ThinkingOverride | undefined,
  persist: (jid: string, group: ConversationRoute) => void | Promise<void>,
): Promise<void> | void {
  const existingGroup = conversationRoutes[chatJid];
  if (!existingGroup) return;

  const prevThinking = existingGroup.agentConfig?.thinking;
  if (JSON.stringify(prevThinking || null) === JSON.stringify(thinking || null))
    return;

  const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
  if (thinking) {
    nextAgentConfig.thinking = thinking;
  } else {
    delete nextAgentConfig.thinking;
  }

  const updatedGroup: ConversationRoute = {
    ...existingGroup,
    agentConfig:
      Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
  };

  const persisted = persist(chatJid, updatedGroup);
  return commitGroupOverride(
    conversationRoutes,
    chatJid,
    updatedGroup,
    persisted,
    {
      group: updatedGroup.name,
      thinkingOverride: thinking ?? null,
    },
    'Updated group thinking override',
  );
}

export function listAvailableGroups(
  chats: ChatRow[],
  conversationRoutes: Record<string, ConversationRoute>,
): AvailableGroup[] {
  const registeredJids = new Set(
    Object.keys(conversationRoutes).map(
      (jid) => parseAgentThreadQueueKey(jid).chatJid,
    ),
  );
  return chats
    .filter((c) => c.jid !== '__group_sync__' && Boolean(c.is_group))
    .map((c) => ({
      jid: c.jid,
      name: c.name || c.jid,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
