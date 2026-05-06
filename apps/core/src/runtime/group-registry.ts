import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME as DEFAULT_ASSISTANT_NAME } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { ConversationRoute, ThinkingOverride } from '../domain/types.js';
import {
  resolveModelAlias,
  resolveModelSelection,
} from '../shared/model-catalog.js';
import { renderDefaultCapabilityRules } from '../shared/capability-guidance.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { AvailableGroup } from './agent-spawn.js';

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

function defaultAgentClaudeMarkdown(
  assistantName: string,
  isMain: boolean,
): string {
  const roleLabel = isMain ? 'main control chat' : 'chat';
  return [
    `# ${assistantName}`,
    '',
    `You are ${assistantName}, the assistant for this ${roleLabel}.`,
    'Keep responses clear, concise, and directly actionable.',
    '',
    'Rules:',
    '- Be explicit when an action fails and what to do next.',
    '- Ask for clarification when intent is ambiguous.',
    '- Never expose secrets unless explicitly requested.',
    renderDefaultCapabilityRules({ includeSettingsTools: true }),
    '',
  ].join('\n');
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
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  conversationRoutes[jid] = group;
  await options.persist(jid, group);

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    fs.writeFileSync(
      groupMdFile,
      defaultAgentClaudeMarkdown(assistantName, group.isMain === true),
    );
    logger.info(
      { folder: group.folder },
      'Created default agent prompt file for registered agent',
    );
  }

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
    const resolved = resolveModelSelection(trimmedModel);
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
  const registeredJids = new Set(Object.keys(conversationRoutes));
  return chats
    .filter((c) => c.jid !== '__group_sync__' && Boolean(c.is_group))
    .map((c) => ({
      jid: c.jid,
      name: c.name || c.jid,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
