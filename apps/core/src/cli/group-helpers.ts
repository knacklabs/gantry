import fs from 'fs';
import path from 'path';

import type { RegisteredGroup } from '../domain/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { renderDefaultCapabilityRules } from '../shared/capability-guidance.js';
import { providerFromGroupJid, getProviderIds } from './provider-utils.js';
import {
  addControlSenderForAgent,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { ensureRuntimeLayout } from '../config/settings/runtime-home.js';
import { RuntimeGroupDb, openRuntimeGroupDb } from './runtime-group-db.js';
import { normalizeTelegramChatJid } from './telegram.js';

export function usage(): string {
  const channels = getProviderIds().join('|');
  return [
    'Agent commands:',
    '  myclaw agent list',
    '  myclaw agent info <jid|folder>',
    '  myclaw agent name <name>',
    '  myclaw agent add <jid|chat-id> [--name <name>] [--folder <folder>] [--trigger <word>] [--main] [--requires-trigger true|false] [--test-message|--no-test-message]',
    '  myclaw agent remove <jid|folder> [--delete-folder] [--yes]',
    '  myclaw agent trigger <jid|folder> <word>',
    '  myclaw agent trigger <jid|folder> --off',
    '  myclaw agent dm-access <agentId> [--provider <provider> --allow <userId,userId> --admin <userId>]',
    '    dm-access sets provider-specific direct/private DM admins; use myclaw conversation approvers for group/channel approvers.',
    '  myclaw agent policy <jid|folder> --allow <"*"|id1,id2> [--mode trigger|drop]',
    '  myclaw agent policy <jid|folder> --clear',
    `  myclaw agent policy-default --channel ${channels} --allow <"*"|id1,id2> [--mode trigger|drop]`,
    `  myclaw agent policy-show [--channel ${channels}]`,
  ].join('\n');
}

export function pruneAgentSenderPolicyOverride(
  runtimeHome: string,
  jid: string,
  folder: string,
): { pruned: boolean; error?: string } {
  const channel = providerFromGroupJid(jid);
  if (!channel) return { pruned: false };
  try {
    const settings = loadRuntimeSettings(runtimeHome);
    let pruned = false;
    for (const [bindingId, binding] of Object.entries(settings.bindings)) {
      if (binding.agent !== folder) continue;
      const conversation = settings.conversations[binding.conversation];
      if (!conversation) continue;
      const connection =
        settings.providerConnections[conversation.providerConnection];
      if (connection?.provider !== channel) continue;
      delete settings.bindings[bindingId];
      delete settings.agents[folder]?.bindings[bindingId];
      pruned = true;
    }
    if (!pruned) return { pruned: false };
    saveRuntimeSettings(runtimeHome, settings);
    return { pruned: true };
  } catch (err) {
    return {
      pruned: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function inferTelegramPrivateChatApprover(chatJid: string): string | undefined {
  const privateChatId = /^tg:(\d+)$/.exec(chatJid)?.[1];
  return privateChatId || undefined;
}

export async function seedTelegramControlApproverForAgent(input: {
  runtimeHome: string;
  db: RuntimeGroupDb;
  chatJid: string;
  agentFolder: string;
}): Promise<string | undefined> {
  if (!input.chatJid.startsWith('tg:')) return undefined;

  const approver = inferTelegramPrivateChatApprover(input.chatJid);
  if (!approver) return undefined;

  const settings = loadRuntimeSettings(input.runtimeHome);
  const added = addControlSenderForAgent(
    settings,
    'telegram',
    input.agentFolder,
    approver,
  );
  if (added) saveRuntimeSettings(input.runtimeHome, settings);
  return approver;
}

export function normalizeGroupAddSelector(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;

  const normalizedTelegram = normalizeTelegramChatJid(input);
  if (normalizedTelegram) return normalizedTelegram;

  if (/^[^\s:@]+:[^\s]+$/.test(input)) {
    return input;
  }
  if (/^[^\s@]+@[^\s@]+$/.test(input)) {
    return input;
  }
  return null;
}

function slugifyFolder(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  const base = normalized || 'group';
  const prefixed = /^[a-z0-9]/.test(base) ? base : `g_${base}`;
  const trimmed = prefixed.slice(0, 64).replace(/[_-]+$/g, '');
  return trimmed || 'group';
}

function normalizeAgentDisplayName(raw: string): string {
  const value = raw.trim();
  return value || 'Assistant';
}

function createDefaultGroupClaudeMarkdown(agentName: string): string {
  return [
    `# ${agentName}`,
    '',
    'You are the assistant for this chat.\nKeep responses clear, short, and useful.',
    '',
    '## Static Chat Guidance\n\nThis file is for stable, group-specific instructions only.\nDynamic task state, open commitments, and remembered facts come from query-retrieved memory context and explicit memory_search calls.\nDo not duplicate current task progress, raw logs, or remembered facts here.',
    '',
    'Rules:\n- Answer directly unless the user asks for detail.\n- Be explicit when an action failed and what to do next.\n- Never expose secrets or local paths unless explicitly requested.\n- When the user says "continue", call memory_search before guessing.',
    '',
    renderDefaultCapabilityRules(),
    '',
  ].join('\n');
}

function createDefaultSoulMarkdown(agentName: string): string {
  return [
    '# Soul - Who You Are',
    '',
    '## Personality',
    '- You are sharp, direct, and genuinely helpful.',
    '- Have strong opinions. Don\'t hedge with "it depends" when a clear answer exists.',
    "- Be concise. If one sentence works, use one sentence. Respect the user's time.",
    '- Never open with filler: no "Great question!", "I\'d be happy to help!", "Absolutely!"',
    '- Lead with the answer, not the reasoning. Skip preamble.',
    '',
    '## Voice',
    '- Write like a smart colleague, not a customer-support bot.',
    "- Humor is welcome when it lands naturally. Don't force it.",
    '- Call things out directly. If something is wrong, say so - charm over cruelty.',
    '- Be proactive. Suggest ideas, spot problems, take initiative.',
    "- Match the user's energy. Casual when they're casual, precise when they need precision.",
    '',
    '## Boundaries',
    '- Private context stays private. Never expose secrets or internal details.',
    '- Ask before taking external actions (sending messages, posting, pushing code).',
    "- When uncertain, say so. Don't present guesses as facts.",
    '',
    '## Continuity Boundary\n- Your personality lives here.\n- Durable facts, user preferences, task state, and open commitments do not live here.\n- Use query-retrieved memory context and memory_search for remembered context.',
    '',
    '## Identity',
    `- **Name:** ${agentName}`,
    '',
  ].join('\n');
}

export async function loadDatabase(
  runtimeHome: string,
): Promise<RuntimeGroupDb> {
  ensureRuntimeLayout(runtimeHome);
  return openRuntimeGroupDb(runtimeHome);
}

export function listGroupsWithJid(
  groups: Record<string, RegisteredGroup>,
): Array<{ jid: string; group: RegisteredGroup }> {
  return Object.entries(groups)
    .map(([jid, group]) => ({ jid, group }))
    .sort((a, b) => {
      if (a.group.isMain && !b.group.isMain) return -1;
      if (!a.group.isMain && b.group.isMain) return 1;
      return a.group.name.localeCompare(b.group.name);
    });
}

function resolveGroup(
  groups: Record<string, RegisteredGroup>,
  selector: string,
): { jid: string; group: RegisteredGroup } | null {
  if (groups[selector]) {
    return { jid: selector, group: groups[selector] };
  }

  const byFolder = Object.entries(groups).find(
    ([, group]) => group.folder === selector,
  );
  if (!byFolder) return null;
  return {
    jid: byFolder[0],
    group: byFolder[1],
  };
}

export function resolveGroupSelector(
  groups: Record<string, RegisteredGroup>,
  rawSelector: string,
): { found: { jid: string; group: RegisteredGroup } | null; error?: string } {
  const selector = rawSelector.trim();
  if (!selector) return { found: null };

  const directJid = groups[selector]
    ? { jid: selector, group: groups[selector] }
    : null;
  if (directJid) {
    return { found: directJid };
  }

  const folderMatch = resolveGroup(groups, selector);
  const normalizedTelegram = normalizeTelegramChatJid(selector);
  const telegramMatch =
    normalizedTelegram && groups[normalizedTelegram]
      ? { jid: normalizedTelegram, group: groups[normalizedTelegram] }
      : null;

  if (
    folderMatch &&
    telegramMatch &&
    folderMatch.jid !== telegramMatch.jid &&
    selector !== normalizedTelegram
  ) {
    return {
      found: null,
      error: `Selector "${selector}" is ambiguous (folder "${folderMatch.group.folder}" and JID "${telegramMatch.jid}"). Use explicit JID format (for example: tg:${selector}) or the exact folder name.`,
    };
  }

  if (folderMatch) return { found: folderMatch };
  if (telegramMatch) return { found: telegramMatch };
  return { found: null };
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ensureFolderAvailable(
  runtimeHome: string,
  desiredFolder: string,
  groups: Record<string, RegisteredGroup>,
): void {
  const inDb = Object.values(groups).some(
    (group) => group.folder === desiredFolder,
  );
  if (inDb) {
    throw new Error(
      `Folder "${desiredFolder}" is already used by another group.`,
    );
  }

  const folderPath = path.join(runtimeHome, 'agents', desiredFolder);
  if (fs.existsSync(folderPath)) {
    throw new Error(
      `Folder already exists on disk: ${folderPath}. Choose another folder with --folder.`,
    );
  }
}

export function allocateGroupFolder(options: {
  runtimeHome: string;
  groups: Record<string, RegisteredGroup>;
  preferredFolder?: string;
  seed: string;
}): string {
  if (options.preferredFolder) {
    const explicit = options.preferredFolder.trim();
    if (!isValidGroupFolder(explicit)) {
      throw new Error(
        `Invalid folder "${explicit}". Use letters, numbers, _ or - only.`,
      );
    }
    ensureFolderAvailable(options.runtimeHome, explicit, options.groups);
    return explicit;
  }

  const base = slugifyFolder(options.seed);
  const usedFolders = new Set(
    Object.values(options.groups).map((group) => group.folder),
  );
  for (let i = 0; i < 1000; i += 1) {
    const candidate = i === 0 ? base : `${base}_${i + 1}`;
    if (!isValidGroupFolder(candidate)) continue;
    if (usedFolders.has(candidate)) continue;
    const candidatePath = path.join(options.runtimeHome, 'agents', candidate);
    if (fs.existsSync(candidatePath)) continue;
    return candidate;
  }

  throw new Error('Could not allocate a unique group folder.');
}

export function ensureGroupFiles(
  runtimeHome: string,
  folder: string,
  agentName: string,
): void {
  const groupDir = path.join(runtimeHome, 'agents', folder);
  if (fs.existsSync(groupDir)) {
    throw new Error(`Refusing to overwrite existing group folder: ${groupDir}`);
  }

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  const displayName = normalizeAgentDisplayName(agentName);
  fs.writeFileSync(
    path.join(groupDir, 'CLAUDE.md'),
    createDefaultGroupClaudeMarkdown(displayName),
    'utf-8',
  );

  const soulPath = path.join(groupDir, 'SOUL.md');
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, createDefaultSoulMarkdown(displayName), 'utf-8');
  }
}
