import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';

import { RegisteredGroup } from '../core/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { readEnvFile } from './env-file.js';
import { envFilePath, ensureRuntimeLayout } from './runtime-home.js';
import { RuntimeGroupDb, openRuntimeGroupDb } from './runtime-group-db.js';
import {
  normalizeTelegramChatJid,
  verifyTelegramChatAccess,
} from './telegram.js';

interface GroupAddOptions {
  selector?: string;
  name?: string;
  folder?: string;
  trigger?: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  sendTestMessage: boolean;
}

interface GroupRemoveOptions {
  selector?: string;
  deleteFolder: boolean;
  assumeYes: boolean;
}

interface GroupTriggerOptions {
  selector?: string;
  trigger?: string;
  disable: boolean;
}

function usage(): string {
  return [
    'Agent commands:',
    '  myclaw agent list',
    '  myclaw agent info <jid|folder>',
    '  myclaw agent add <jid|chat-id> [--name <name>] [--folder <folder>] [--trigger <word>] [--main] [--requires-trigger true|false] [--test-message|--no-test-message]',
    '  myclaw agent remove <jid|folder> [--delete-folder] [--yes]',
    '  myclaw agent trigger <jid|folder> <word>',
    '  myclaw agent trigger <jid|folder> --off',
  ].join('\n');
}

function parseBooleanFlag(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') {
    return false;
  }
  return null;
}

function normalizeGroupAddSelector(raw: string): string | null {
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

function createDefaultGroupClaudeMarkdown(): string {
  return [
    '# MyClaw Group Assistant',
    '',
    'You are the assistant for this chat.',
    'Keep responses clear, short, and useful.',
    '',
    'Rules:',
    '- Answer directly unless the user asks for detail.',
    '- Be explicit when an action failed and what to do next.',
    '- Never expose secrets or local paths unless explicitly requested.',
    '',
  ].join('\n');
}

async function loadDatabase(runtimeHome: string): Promise<RuntimeGroupDb> {
  ensureRuntimeLayout(runtimeHome);
  return openRuntimeGroupDb(runtimeHome);
}

function listGroupsWithJid(
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

function resolveGroupSelector(
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

function isInteractiveTerminal(): boolean {
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
      `Folder \"${desiredFolder}\" is already used by another group.`,
    );
  }

  const folderPath = path.join(runtimeHome, 'agents', desiredFolder);
  if (fs.existsSync(folderPath)) {
    throw new Error(
      `Folder already exists on disk: ${folderPath}. Choose another folder with --folder.`,
    );
  }
}

function allocateGroupFolder(options: {
  runtimeHome: string;
  groups: Record<string, RegisteredGroup>;
  preferredFolder?: string;
  seed: string;
}): string {
  if (options.preferredFolder) {
    const explicit = options.preferredFolder.trim();
    if (!isValidGroupFolder(explicit)) {
      throw new Error(
        `Invalid folder \"${explicit}\". Use letters, numbers, _ or - only.`,
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

function ensureGroupFiles(runtimeHome: string, folder: string): void {
  const groupDir = path.join(runtimeHome, 'agents', folder);
  if (fs.existsSync(groupDir)) {
    throw new Error(`Refusing to overwrite existing group folder: ${groupDir}`);
  }

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, 'CLAUDE.md'),
    createDefaultGroupClaudeMarkdown(),
    'utf-8',
  );
}

function parseGroupAddArgs(
  args: string[],
): GroupAddOptions | { error: string } {
  const options: GroupAddOptions = {
    sendTestMessage: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--name') {
      options.name = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length);
      continue;
    }

    if (arg === '--folder') {
      options.folder = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--folder=')) {
      options.folder = arg.slice('--folder='.length);
      continue;
    }

    if (arg === '--trigger') {
      options.trigger = args[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--trigger=')) {
      options.trigger = arg.slice('--trigger='.length);
      continue;
    }

    if (arg === '--main') {
      options.isMain = true;
      continue;
    }
    if (arg === '--no-main') {
      options.isMain = false;
      continue;
    }

    if (arg === '--requires-trigger') {
      const rawValue = args[i + 1] || '';
      const parsed = parseBooleanFlag(rawValue);
      if (parsed === null) {
        return {
          error:
            'Invalid value for --requires-trigger. Use true/false (or yes/no, on/off).',
        };
      }
      options.requiresTrigger = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--requires-trigger=')) {
      const parsed = parseBooleanFlag(arg.slice('--requires-trigger='.length));
      if (parsed === null) {
        return {
          error:
            'Invalid value for --requires-trigger. Use true/false (or yes/no, on/off).',
        };
      }
      options.requiresTrigger = parsed;
      continue;
    }

    if (arg === '--test-message') {
      options.sendTestMessage = true;
      continue;
    }
    if (arg === '--no-test-message') {
      options.sendTestMessage = false;
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent add: ${arg}` };
    }

    if (!options.selector) {
      options.selector = arg;
      continue;
    }

    return { error: `Unexpected argument for agent add: ${arg}` };
  }

  if (!options.selector) {
    return {
      error: 'Missing JID/chat-id. Usage: myclaw agent add <jid|chat-id> ...',
    };
  }

  return options;
}

function parseGroupRemoveArgs(
  args: string[],
): GroupRemoveOptions | { error: string } {
  const options: GroupRemoveOptions = {
    deleteFolder: false,
    assumeYes: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--delete-folder') {
      options.deleteFolder = true;
      continue;
    }
    if (arg === '--yes' || arg === '-y') {
      options.assumeYes = true;
      continue;
    }
    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent remove: ${arg}` };
    }

    if (!options.selector) {
      options.selector = arg;
      continue;
    }
    return { error: `Unexpected argument for agent remove: ${arg}` };
  }

  if (!options.selector) {
    return {
      error:
        'Missing agent selector. Usage: myclaw agent remove <jid|folder> [--delete-folder]',
    };
  }

  return options;
}

function parseGroupTriggerArgs(
  args: string[],
): GroupTriggerOptions | { error: string } {
  const options: GroupTriggerOptions = {
    disable: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--off') {
      options.disable = true;
      continue;
    }

    if (arg.startsWith('--')) {
      return { error: `Unknown option for agent trigger: ${arg}` };
    }

    if (!options.selector) {
      options.selector = arg;
      continue;
    }

    if (!options.trigger) {
      options.trigger = arg;
      continue;
    }

    return { error: `Unexpected argument for agent trigger: ${arg}` };
  }

  if (!options.selector) {
    return {
      error:
        'Missing agent selector. Usage: myclaw agent trigger <jid|folder> <word>|--off',
    };
  }
  if (!options.disable && !options.trigger) {
    return {
      error:
        'Missing trigger word. Usage: myclaw agent trigger <jid|folder> <word>',
    };
  }

  return options;
}

async function runList(runtimeHome: string): Promise<number> {
  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not open runtime database: ${message}`);
    return 1;
  }

  try {
    let groups: Array<{ jid: string; group: RegisteredGroup }>;
    try {
      groups = listGroupsWithJid(db.getAllRegisteredGroups());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(
        `Could not read registered groups from database. The DB may be corrupted. Details: ${message}`,
      );
      return 1;
    }

    if (groups.length === 0) {
      p.log.warn('No agents are registered in this runtime home.');
      p.log.info(
        'Next action: run `myclaw agent add <chat-id>` or `myclaw telegram connect`.',
      );
      return 0;
    }

    const lines = [
      'Registered agents:',
      '',
      'JID | Name | Folder | Trigger | Main | Requires Trigger',
    ];

    for (const entry of groups) {
      lines.push(
        [
          entry.jid,
          entry.group.name,
          entry.group.folder,
          entry.group.trigger,
          entry.group.isMain ? 'yes' : 'no',
          entry.group.requiresTrigger === false ? 'no' : 'yes',
        ].join(' | '),
      );
    }

    console.log(lines.join('\n'));
    return 0;
  } finally {
    db?.close();
  }
}

async function runInfo(
  runtimeHome: string,
  rawSelector?: string,
): Promise<number> {
  if (!rawSelector) {
    p.log.error('Usage: myclaw agent info <jid|folder>');
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not open runtime database: ${message}`);
    return 1;
  }

  try {
    let groups: Record<string, RegisteredGroup>;
    try {
      groups = db.getAllRegisteredGroups();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not read groups from database: ${message}`);
      return 1;
    }

    const resolved = resolveGroupSelector(groups, rawSelector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${rawSelector.trim()}".`);
      return 1;
    }

    const found = resolved.found;
    const lines = [
      `JID: ${found.jid}`,
      `Name: ${found.group.name}`,
      `Folder: ${found.group.folder}`,
      `Trigger: ${found.group.trigger}`,
      `Requires Trigger: ${found.group.requiresTrigger === false ? 'no' : 'yes'}`,
      `Main Group: ${found.group.isMain ? 'yes' : 'no'}`,
      `Added At: ${found.group.added_at}`,
    ];
    console.log(lines.join('\n'));
    return 0;
  } finally {
    db?.close();
  }
}

async function runAdd(runtimeHome: string, args: string[]): Promise<number> {
  const parsed = parseGroupAddArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  const normalized = normalizeGroupAddSelector(parsed.selector || '');
  if (!normalized) {
    p.log.error('Invalid JID/chat-id. Example: tg:-1001234567890');
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not open runtime database: ${message}`);
    return 1;
  }

  try {
    let groups: Record<string, RegisteredGroup>;
    try {
      groups = db.getAllRegisteredGroups();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not read groups from database: ${message}`);
      return 1;
    }

    if (groups[normalized]) {
      p.log.error(`Agent already exists for ${normalized}.`);
      p.log.info(
        'Next action: run `myclaw agent info <jid>` or `myclaw agent trigger <jid> <word>`.',
      );
      return 1;
    }

    let displayName = parsed.name?.trim() || '';
    let chatProbeMessage = '';

    if (normalized.startsWith('tg:')) {
      const env = readEnvFile(envFilePath(runtimeHome));
      const token = env.TELEGRAM_BOT_TOKEN?.trim() || '';
      if (!token) {
        p.log.error('TELEGRAM_BOT_TOKEN is missing.');
        p.log.info(
          'Next action: run `myclaw config set TELEGRAM_BOT_TOKEN <token>` first.',
        );
        return 1;
      }

      const spinner = p.spinner();
      spinner.start('Verifying Telegram chat access...');
      const access = await verifyTelegramChatAccess({
        token,
        chatJid: normalized,
        sendTestMessage: parsed.sendTestMessage,
      });
      if (!access.ok) {
        spinner.stop('Telegram chat verification failed');
        p.note(
          `${access.message}\nNext action: ${access.nextAction || 'Fix Telegram access and retry.'}`,
          'Telegram Check',
        );
        return 1;
      }
      spinner.stop(access.message);
      displayName = displayName || access.chatTitle || 'Telegram Group';
      chatProbeMessage = access.sentTestMessage
        ? 'A Telegram test message was sent to confirm bot access.'
        : 'Telegram chat access was confirmed (test message skipped).';
    }

    if (!displayName) {
      displayName = normalized;
    }

    const groupFolder = allocateGroupFolder({
      runtimeHome,
      groups,
      preferredFolder: parsed.folder,
      seed: `${displayName}_${normalized}`,
    });

    try {
      ensureGroupFiles(runtimeHome, groupFolder);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not create group folder: ${message}`);
      return 1;
    }

    const requiresTrigger =
      parsed.requiresTrigger ?? (parsed.isMain ? false : true);

    const record: RegisteredGroup = {
      name: displayName,
      folder: groupFolder,
      trigger: (parsed.trigger || '@Andy').trim() || '@Andy',
      added_at: new Date().toISOString(),
      requiresTrigger,
      isMain: parsed.isMain || false,
    };

    try {
      if (record.isMain) {
        for (const [jid, group] of Object.entries(groups)) {
          if (!group.isMain) continue;
          db.setRegisteredGroup(jid, {
            ...group,
            isMain: false,
          });
        }
      }
      db.setRegisteredGroup(normalized, record);
    } catch (err) {
      const groupDir = path.join(runtimeHome, 'agents', groupFolder);
      if (fs.existsSync(groupDir)) {
        try {
          fs.rmSync(groupDir, { recursive: true, force: true });
        } catch {
          // Best effort rollback; keep the original database error.
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not save agent in database: ${message}`);
      return 1;
    }

    p.log.success(
      `Added agent ${displayName} (${normalized}) in folder ${groupFolder}.`,
    );
    if (chatProbeMessage) {
      p.log.info(chatProbeMessage);
    }
    return 0;
  } finally {
    db?.close();
  }
}

async function runRemove(runtimeHome: string, args: string[]): Promise<number> {
  const parsed = parseGroupRemoveArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not open runtime database: ${message}`);
    return 1;
  }

  try {
    let groups: Record<string, RegisteredGroup>;
    try {
      groups = db.getAllRegisteredGroups();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not read groups from database: ${message}`);
      return 1;
    }

    const selector = parsed.selector || '';
    const resolved = resolveGroupSelector(groups, selector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${selector.trim()}".`);
      return 1;
    }
    const found = resolved.found;

    if (!parsed.assumeYes) {
      if (!isInteractiveTerminal()) {
        p.log.error(
          'Refusing destructive removal in non-interactive mode without --yes.',
        );
        p.log.info(
          'Next action: rerun with `--yes` (and `--delete-folder` if you want to remove files too).',
        );
        return 1;
      }

      const folderPath = path.join(runtimeHome, 'agents', found.group.folder);
      const decision = await p.select({
        message: parsed.deleteFolder
          ? `Remove ${found.group.name} (${found.jid}) and delete folder ${folderPath}?`
          : `Remove ${found.group.name} (${found.jid}) from the database?`,
        options: [
          { label: 'Yes, remove it', value: 'yes' },
          { label: 'No, cancel', value: 'no' },
        ],
      });
      if (p.isCancel(decision) || decision !== 'yes') {
        p.log.warn('Agent removal cancelled. No changes were made.');
        return 0;
      }
    }

    try {
      db.deleteRegisteredGroup(found.jid);
      db.deleteSession(found.group.folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not remove agent from database: ${message}`);
      return 1;
    }

    if (parsed.deleteFolder) {
      const folderPath = path.join(runtimeHome, 'agents', found.group.folder);
      try {
        if (fs.existsSync(folderPath)) {
          fs.rmSync(folderPath, { recursive: true, force: false });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        p.log.warn(
          `Agent removed from database, but folder cleanup failed: ${folderPath}. Details: ${message}`,
        );
        return 1;
      }
    }

    p.log.success(`Removed agent ${found.group.name} (${found.jid}).`);
    if (!parsed.deleteFolder) {
      p.log.info(
        `Agent folder preserved at ${path.join(runtimeHome, 'agents', found.group.folder)}. Use --delete-folder to remove it.`,
      );
    }
    return 0;
  } finally {
    db?.close();
  }
}

async function runTrigger(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseGroupTriggerArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  let db: RuntimeGroupDb | null = null;
  try {
    db = await loadDatabase(runtimeHome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not open runtime database: ${message}`);
    return 1;
  }

  try {
    let groups: Record<string, RegisteredGroup>;
    try {
      groups = db.getAllRegisteredGroups();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not read groups from database: ${message}`);
      return 1;
    }

    const selector = parsed.selector || '';
    const resolved = resolveGroupSelector(groups, selector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${selector.trim()}".`);
      return 1;
    }
    const found = resolved.found;

    const nextGroup: RegisteredGroup = {
      ...found.group,
      requiresTrigger: parsed.disable ? false : true,
      trigger: parsed.disable
        ? found.group.trigger
        : (parsed.trigger || '').trim() || found.group.trigger,
    };

    if (!parsed.disable && !nextGroup.trigger.trim()) {
      p.log.error('Trigger word cannot be empty.');
      return 1;
    }

    try {
      db.setRegisteredGroup(found.jid, nextGroup);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not update trigger settings: ${message}`);
      return 1;
    }

    if (parsed.disable) {
      p.log.success(
        `Trigger requirement disabled for ${found.group.name} (${found.jid}).`,
      );
      return 0;
    }

    p.log.success(
      `Trigger for ${found.group.name} (${found.jid}) is now "${nextGroup.trigger}".`,
    );
    return 0;
  } finally {
    db?.close();
  }
}

export async function runAgentCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(usage());
    return subcommand ? 0 : 1;
  }

  if (subcommand === 'list') {
    return runList(runtimeHome);
  }

  if (subcommand === 'info') {
    return runInfo(runtimeHome, rest[0]);
  }

  if (subcommand === 'add') {
    return runAdd(runtimeHome, rest);
  }

  if (subcommand === 'remove') {
    return runRemove(runtimeHome, rest);
  }

  if (subcommand === 'trigger') {
    return runTrigger(runtimeHome, rest);
  }

  p.log.error(`Unknown agent command: ${subcommand}`);
  console.log(usage());
  return 1;
}
