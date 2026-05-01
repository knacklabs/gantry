import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME as DEFAULT_ASSISTANT_NAME } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { RegisteredGroup, ThinkingOverride } from '../domain/types.js';
import { normalizeClaudeModelSelection } from '../models/claude-model-registry.js';
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
  persist: (jid: string, group: RegisteredGroup) => void | Promise<void>;
  ensureCredentialBinding: (jid: string, group: RegisteredGroup) => void;
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
  registeredGroups: Record<string, RegisteredGroup>,
  chatJid: string,
  updatedGroup: RegisteredGroup,
  persisted: void | Promise<void>,
  logContext: Record<string, unknown>,
  logMessage: string,
): void | Promise<void> {
  const commit = () => {
    registeredGroups[chatJid] = updatedGroup;
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
    '- Use send_message for progress updates and ask_user_question for structured choices.',
    '- Use request_skill_install, request_skill_proposal, request_skill_dependency_install, request_mcp_server, request_tool_enable, or request_channel_tool_enable for capability changes.',
    '- Main/admin agents may use service_restart after approved changes and register_agent for channel binding.',
    '- Never run dependency installs or edit .claude/skills, .mcp.json, settings, or generated capability config directly.',
    '',
  ].join('\n');
}

export async function registerGroup(
  registeredGroups: Record<string, RegisteredGroup>,
  jid: string,
  group: RegisteredGroup,
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

  registeredGroups[jid] = group;
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
  registeredGroups: Record<string, RegisteredGroup>,
  chatJid: string,
  model: string | undefined,
  persist: (jid: string, group: RegisteredGroup) => void | Promise<void>,
): Promise<void> | void {
  const existingGroup = registeredGroups[chatJid];
  if (!existingGroup) return;

  const normalizedModel = normalizeClaudeModelSelection(model);
  const prevModel = existingGroup.agentConfig?.model;
  if (prevModel === normalizedModel) return;

  const nextAgentConfig = { ...(existingGroup.agentConfig || {}) };
  if (normalizedModel) {
    nextAgentConfig.model = normalizedModel;
  } else {
    delete nextAgentConfig.model;
  }

  const updatedGroup: RegisteredGroup = {
    ...existingGroup,
    agentConfig:
      Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
  };

  const persisted = persist(chatJid, updatedGroup);
  return commitGroupOverride(
    registeredGroups,
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
  registeredGroups: Record<string, RegisteredGroup>,
  chatJid: string,
  thinking: ThinkingOverride | undefined,
  persist: (jid: string, group: RegisteredGroup) => void | Promise<void>,
): Promise<void> | void {
  const existingGroup = registeredGroups[chatJid];
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

  const updatedGroup: RegisteredGroup = {
    ...existingGroup,
    agentConfig:
      Object.keys(nextAgentConfig).length > 0 ? nextAgentConfig : undefined,
  };

  const persisted = persist(chatJid, updatedGroup);
  return commitGroupOverride(
    registeredGroups,
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
  registeredGroups: Record<string, RegisteredGroup>,
): AvailableGroup[] {
  const registeredJids = new Set(Object.keys(registeredGroups));
  return chats
    .filter((c) => c.jid !== '__group_sync__' && Boolean(c.is_group))
    .map((c) => ({
      jid: c.jid,
      name: c.name || c.jid,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
