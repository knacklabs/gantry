import fs from 'fs';
import path from 'path';

import type { ConversationRoute } from '../domain/types.js';
import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import {
  createProfileFileMirrorExists,
  createProfileFileMirrorWriter,
} from '../platform/profile-file-mirror.js';
import { PromptProfileService } from '../application/agents/prompt-profile-service.js';
import { providerFromGroupJid, getProviderIds } from './provider-utils.js';
import {
  addControlSenderForAgent,
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { ensureRuntimeLayout } from '../config/settings/runtime-home.js';
import { RuntimeGroupDb, openRuntimeGroupDb } from './runtime-group-db.js';
import { normalizeTelegramChatJid } from './telegram.js';
import { providerForJid } from '../channels/provider-registry.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';

export { formatAgentHarnessLine } from './group-engine.js';

export function usage(): string {
  const channels = getProviderIds().join('|');
  return [
    'Agent commands:',
    '  gantry agent list',
    '  gantry agent info <jid|folder>',
    '  gantry agent name <name>',
    '  gantry agent add <jid|chat-id> [--name <name>] [--folder <folder>] [--trigger <word>] [--requires-trigger true|false] [--test-message|--no-test-message]',
    '  gantry agent remove <jid|folder> [--delete-folder] [--yes]',
    '  gantry agent trigger <jid|folder> <word>',
    '  gantry agent trigger <jid|folder> --off',
    '  gantry conversation approvers <conversation-id> [--allow <userId,userId>]',
    '    conversation approvers manage direct/private and group/channel approval policy.',
    '  gantry agent policy <jid|folder> --allow <"*"|id1,id2> [--mode trigger|drop]',
    '  gantry agent policy <jid|folder> --clear',
    `  gantry agent policy-default --channel ${channels} --allow <"*"|id1,id2> [--mode trigger|drop]`,
    `  gantry agent policy-show [--channel ${channels}]`,
    '  gantry agent access show <jid|folder>',
    '  gantry agent access apply <jid|folder> --file <path|->',
    '  gantry agent access preset <folder> <full|locked>',
    '  gantry agent harness <jid|folder> <auto|anthropic_sdk|deepagents>',
    '  gantry agent profile list <jid|folder>',
    '  gantry agent profile read <jid|folder> <soul|agents>',
    '  gantry agent profile set <jid|folder> <soul|agents> --file <path|-> [--expect-version N]',
    '  gantry agent profile import <jid|folder> <soul|agents>',
    '  gantry agent profile export <jid|folder> [<soul|agents>]',
  ].join('\n');
}

export function findConversationIdForAgent(
  settings: ReturnType<typeof loadRuntimeSettings>,
  agentId: string,
  providerId: string,
): string | null {
  for (const binding of Object.values(settings.bindings)) {
    if (binding.agent !== agentId) continue;
    const conversation = settings.conversations[binding.conversation];
    if (!conversation) continue;
    const connection = settings.providerAccounts[conversation.providerAccount];
    if (connection?.provider === providerId) return binding.conversation;
  }
  return null;
}

export function conversationIdsForProvider(
  settings: ReturnType<typeof loadRuntimeSettings>,
  providerId: string,
): string[] {
  return Object.entries(settings.conversations)
    .filter(
      ([, conversation]) =>
        settings.providerAccounts[conversation.providerAccount]?.provider ===
        providerId,
    )
    .map(([conversationId]) => conversationId);
}

export async function pruneAgentSenderPolicyOverride(
  runtimeHome: string,
  jid: string,
  folder: string,
): Promise<{ pruned: boolean; error?: string }> {
  const channel = providerFromGroupJid(jid);
  if (!channel) return { pruned: false };
  try {
    const settings = loadRuntimeSettings(runtimeHome);
    const previousSettings = structuredClone(settings);
    const provider = providerForJid(jid);
    const externalId =
      provider && jid.startsWith(provider.jidPrefix)
        ? jid.slice(provider.jidPrefix.length)
        : jid;
    let pruned = false;
    for (const [bindingId, binding] of Object.entries(settings.bindings)) {
      if (binding.agent !== folder) continue;
      const agentBinding = settings.agents[folder]?.bindings[bindingId];
      if (agentBinding?.jid && agentBinding.jid !== jid) continue;
      const conversation = settings.conversations[binding.conversation];
      if (!conversation) continue;
      const connection =
        settings.providerAccounts[conversation.providerAccount];
      if (connection?.provider !== channel) continue;
      if (!agentBinding?.jid && conversation.externalId !== externalId) {
        continue;
      }
      delete settings.bindings[bindingId];
      delete settings.agents[folder]?.bindings[bindingId];
      const installKey =
        binding.installKey ??
        Object.entries(conversation.installedAgents).find(
          ([, install]) =>
            install.agentId === folder &&
            (install.threadId ?? '') === (binding.threadId ?? ''),
        )?.[0] ??
        folder;
      delete conversation.installedAgents[installKey];
      if (Object.keys(conversation.installedAgents).length === 0) {
        delete settings.conversations[binding.conversation];
      }
      pruned = true;
    }
    if (!pruned) return { pruned: false };
    await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
    });
    return { pruned: true };
  } catch (err) {
    return {
      pruned: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function syncConfiguredConversationBinding(input: {
  runtimeHome: string;
  agentId: string;
  agentName: string;
  agentFolder: string;
  jid: string;
  displayName: string;
  trigger: string;
  requiresTrigger: boolean;
}): Promise<void> {
  const settings = loadRuntimeSettings(input.runtimeHome);
  const previousSettings = structuredClone(settings);
  ensureConfiguredConversationBinding(settings, {
    agentId: input.agentId,
    agentName: input.agentName,
    agentFolder: input.agentFolder,
    jid: input.jid,
    displayName: input.displayName,
    trigger: input.trigger,
    requiresTrigger: input.requiresTrigger,
  });
  await writeDesiredRuntimeSettings({
    runtimeHome: input.runtimeHome,
    settings,
    previousSettings,
  });
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
  const previousSettings = structuredClone(settings);
  const added = addControlSenderForAgent(
    settings,
    'telegram',
    input.agentFolder,
    approver,
  );
  if (added) {
    await writeDesiredRuntimeSettings({
      runtimeHome: input.runtimeHome,
      settings,
      previousSettings,
    });
  }
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

export async function loadDatabase(
  runtimeHome: string,
): Promise<RuntimeGroupDb> {
  ensureRuntimeLayout(runtimeHome);
  return openRuntimeGroupDb(runtimeHome);
}

export function listGroupsWithJid(
  groups: Record<string, ConversationRoute>,
): Array<{ jid: string; group: ConversationRoute }> {
  return Object.entries(groups)
    .map(([jid, group]) => ({ jid, group }))
    .sort((a, b) => a.group.name.localeCompare(b.group.name));
}

function resolveGroup(
  groups: Record<string, ConversationRoute>,
  selector: string,
): { jid: string; group: ConversationRoute } | null {
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

function resolveBareJidRoute(
  groups: Record<string, ConversationRoute>,
  rawSelector: string,
  bareJid: string,
): { found: { jid: string; group: ConversationRoute } | null; error?: string } {
  const matches = Object.entries(groups).filter(
    ([jid]) =>
      jid !== bareJid && parseAgentThreadQueueKey(jid).chatJid === bareJid,
  );
  if (matches.length === 0) return { found: null };
  if (matches.length > 1) {
    return {
      found: null,
      error: `Selector "${rawSelector}" is ambiguous: conversation "${bareJid}" has multiple agent routes. Use the folder/agent selector.`,
    };
  }
  const [jid, group] = matches[0]!;
  return { found: { jid, group } };
}

export function resolveGroupSelector(
  groups: Record<string, ConversationRoute>,
  rawSelector: string,
): { found: { jid: string; group: ConversationRoute } | null; error?: string } {
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
  const bareJid = normalizeGroupAddSelector(selector);
  const bareRouteMatch = bareJid
    ? resolveBareJidRoute(groups, selector, bareJid)
    : { found: null };
  if (bareRouteMatch.error) return bareRouteMatch;
  if (bareRouteMatch.found) return { found: bareRouteMatch.found };
  return { found: null };
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function ensureFolderAvailable(
  runtimeHome: string,
  desiredFolder: string,
  groups: Record<string, ConversationRoute>,
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
  groups: Record<string, ConversationRoute>;
  preferredFolder?: string;
  seed: string;
}): string {
  if (options.preferredFolder) {
    const explicit = options.preferredFolder.trim();
    if (!isValidWorkspaceFolder(explicit)) {
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
    if (!isValidWorkspaceFolder(candidate)) continue;
    if (usedFolders.has(candidate)) continue;
    const candidatePath = path.join(options.runtimeHome, 'agents', candidate);
    if (fs.existsSync(candidatePath)) continue;
    return candidate;
  }

  throw new Error('Could not allocate a unique agent folder.');
}

export async function ensureGroupFiles(
  runtimeHome: string,
  folder: string,
  agentName: string,
  fileArtifactStore: FileArtifactStore,
): Promise<void> {
  const groupDir = path.join(runtimeHome, 'agents', folder);
  if (fs.existsSync(groupDir)) {
    throw new Error(`Refusing to overwrite existing agent folder: ${groupDir}`);
  }

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  await new PromptProfileService({
    fileArtifactStore: () => fileArtifactStore,
    mirrorProfileFile: createProfileFileMirrorWriter(runtimeHome),
    mirrorFileExists: createProfileFileMirrorExists(runtimeHome),
  }).ensureAgentDefaults({
    agentFolder: folder,
    agentName: normalizeAgentDisplayName(agentName),
  });
}
