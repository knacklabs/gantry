import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';

import type { RegisteredGroup } from '../domain/types.js';
import { channelFromGroupJid, getChannelIds } from './channel-utils.js';
import { readEnvFile } from '../config/env/file.js';
import { envFilePath } from '../config/settings/runtime-home.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  defaultTriggerForAgentName,
  displayAgentName,
  mainAgentNameFromSettings,
  normalizeMainAgentName,
} from './main-agent.js';
import { RuntimeGroupDb } from './runtime-group-db.js';
import { verifyTelegramChatAccess } from './telegram.js';
import {
  parseGroupAddArgs,
  parseGroupPolicyArgs,
  parseGroupPolicyDefaultArgs,
  parseGroupPolicyShowArgs,
  parseGroupRemoveArgs,
  parseGroupTriggerArgs,
} from './group-args.js';
import {
  allocateGroupFolder,
  ensureGroupFiles,
  isInteractiveTerminal,
  listGroupsWithJid,
  loadDatabase,
  normalizeGroupAddSelector,
  pruneAgentSenderPolicyOverride,
  resolveGroupSelector,
  usage,
} from './group-helpers.js';
import { printPolicyChannel } from './group-policy-format.js';

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
      groups = listGroupsWithJid(await db.getAllRegisteredGroups());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(
        `Could not read registered groups from database. The DB may be corrupted. Details: ${message}`,
      );
      return 1;
    }

    if (groups.length === 0) {
      p.log.warn('No agents are registered in this runtime home.');
      const connectCommands = getChannelIds().map(
        (channel) => `\`myclaw channel connect ${channel}\``,
      );
      p.log.info(
        `Next action: run \`myclaw agent add <chat-id>\` or ${connectCommands.join(' / ')}.`,
      );
      return 0;
    }

    const settings = loadRuntimeSettings(runtimeHome);
    const mainAgentName = mainAgentNameFromSettings(settings);
    const lines = [
      'Registered agents:',
      '',
      'JID | Name | Folder | Trigger | Main | Requires Trigger',
    ];

    for (const entry of groups) {
      lines.push(
        [
          entry.jid,
          displayAgentName(entry.group, mainAgentName),
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
    await db?.close();
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
      groups = await db.getAllRegisteredGroups();
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
    const settings = loadRuntimeSettings(runtimeHome);
    const mainAgentName = mainAgentNameFromSettings(settings);
    const lines = [
      `JID: ${found.jid}`,
      `Name: ${displayAgentName(found.group, mainAgentName)}`,
      `Folder: ${found.group.folder}`,
      `Trigger: ${found.group.trigger}`,
      `Requires Trigger: ${found.group.requiresTrigger === false ? 'no' : 'yes'}`,
      `Main Agent: ${found.group.isMain ? 'yes' : 'no'}`,
      `Added At: ${found.group.added_at}`,
    ];
    console.log(lines.join('\n'));
    return 0;
  } finally {
    await db?.close();
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
      groups = await db.getAllRegisteredGroups();
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
      ensureGroupFiles(runtimeHome, groupFolder, displayName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not create group folder: ${message}`);
      return 1;
    }

    const settings = loadRuntimeSettings(runtimeHome);
    const requiresTrigger =
      parsed.requiresTrigger ?? (parsed.isMain ? false : true);
    const defaultTrigger = defaultTriggerForAgentName(
      mainAgentNameFromSettings(settings),
    );

    const record: RegisteredGroup = {
      name: displayName,
      folder: groupFolder,
      trigger: (parsed.trigger || defaultTrigger).trim() || defaultTrigger,
      added_at: new Date().toISOString(),
      requiresTrigger,
      isMain: parsed.isMain || false,
    };

    try {
      if (record.isMain) {
        for (const [jid, group] of Object.entries(groups)) {
          if (!group.isMain) continue;
          await db.setRegisteredGroup(jid, {
            ...group,
            isMain: false,
          });
        }
      }
      await db.setRegisteredGroup(normalized, record);
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
    if (chatProbeMessage) p.log.info(chatProbeMessage);
    return 0;
  } finally {
    await db?.close();
  }
}

async function runName(runtimeHome: string, args: string[]): Promise<number> {
  const nextName = normalizeMainAgentName(args.join(' '));
  if (nextName.length > 80) {
    p.log.error('Main agent name must be 80 characters or fewer.');
    return 1;
  }
  try {
    const settings = loadRuntimeSettings(runtimeHome);
    const previous = mainAgentNameFromSettings(settings);
    settings.agent.name = nextName;
    saveRuntimeSettings(runtimeHome, settings);
    p.log.success(
      `Main agent name updated from "${previous}" to "${nextName}".`,
    );
    p.log.info(
      'Restart MyClaw for all running processes to pick up the new identity.',
    );
    return 0;
  } catch (err) {
    p.log.error(
      `Could not update main agent name: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
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
      groups = await db.getAllRegisteredGroups();
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
      await db.deleteRegisteredGroup(found.jid);
      await db.deleteSession(found.group.folder);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      p.log.error(`Could not remove agent from database: ${message}`);
      return 1;
    }

    const policyPrune = pruneAgentSenderPolicyOverride(
      runtimeHome,
      found.jid,
      found.group.folder,
    );
    if (policyPrune.error) {
      p.log.warn(
        `Agent removed, but sender policy cleanup failed for folder ${found.group.folder}: ${policyPrune.error}`,
      );
    } else if (policyPrune.pruned) {
      p.log.info(
        `Removed sender policy override for folder ${found.group.folder}.`,
      );
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
    await db?.close();
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
      groups = await db.getAllRegisteredGroups();
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
      await db.setRegisteredGroup(found.jid, nextGroup);
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
    await db?.close();
  }
}

async function runPolicy(runtimeHome: string, args: string[]): Promise<number> {
  const parsed = parseGroupPolicyArgs(args);
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
    const groups = await db.getAllRegisteredGroups();
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
    const channel = channelFromGroupJid(found.jid);
    if (!channel) {
      p.log.error(
        `Agent ${found.group.name} (${found.jid}) does not map to a registered channel provider.`,
      );
      return 1;
    }

    const settings = loadRuntimeSettings(runtimeHome);
    const policy = settings.channels[channel].senderAllowlist;

    if (parsed.clear) {
      delete policy.agents[found.group.folder];
      saveRuntimeSettings(runtimeHome, settings);
      p.log.success(
        `Cleared sender policy override for ${found.group.name} (${found.group.folder}) in ${channel}.`,
      );
      return 0;
    }

    const existing = policy.agents[found.group.folder];
    policy.agents[found.group.folder] = {
      allow: parsed.allow!,
      mode: parsed.mode ?? existing?.mode ?? policy.default.mode,
    };
    saveRuntimeSettings(runtimeHome, settings);
    p.log.success(
      `Updated ${channel} sender policy for ${found.group.name} (${found.group.folder}).`,
    );
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not update sender policy: ${message}`);
    return 1;
  } finally {
    await db?.close();
  }
}

async function runPolicyDefault(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseGroupPolicyDefaultArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  try {
    const settings = loadRuntimeSettings(runtimeHome);
    const channel = parsed.channel;
    const allow = parsed.allow;
    if (!channel || allow === undefined) {
      p.log.error('Missing required policy-default arguments.');
      return 1;
    }
    const policy = settings.channels[channel].senderAllowlist;
    policy.default = {
      allow,
      mode: parsed.mode ?? policy.default.mode,
    };
    saveRuntimeSettings(runtimeHome, settings);
    p.log.success(`Updated default sender policy for ${channel} channel.`);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not update default sender policy: ${message}`);
    return 1;
  }
}

async function runPolicyShow(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseGroupPolicyShowArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  try {
    const settings = loadRuntimeSettings(runtimeHome);
    if (parsed.channel) {
      printPolicyChannel(parsed.channel, settings);
      return 0;
    }
    const channels = getChannelIds();
    for (let i = 0; i < channels.length; i += 1) {
      printPolicyChannel(channels[i]!, settings);
      if (i < channels.length - 1) {
        console.log('');
      }
    }
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(`Could not read sender policies: ${message}`);
    return 1;
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
  switch (subcommand) {
    case 'list':
      return runList(runtimeHome);
    case 'info':
      return runInfo(runtimeHome, rest[0]);
    case 'add':
      return runAdd(runtimeHome, rest);
    case 'name':
      return runName(runtimeHome, rest);
    case 'remove':
      return runRemove(runtimeHome, rest);
    case 'trigger':
      return runTrigger(runtimeHome, rest);
    case 'policy':
      return runPolicy(runtimeHome, rest);
    case 'policy-default':
      return runPolicyDefault(runtimeHome, rest);
    case 'policy-show':
      return runPolicyShow(runtimeHome, rest);
    default:
      p.log.error(`Unknown agent command: ${subcommand}`);
      console.log(usage());
      return 1;
  }
}
