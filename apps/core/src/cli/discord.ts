import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import type {
  DiscordDiscoveredChannel,
  DiscordSetupCredentials,
  DiscordSetupDiscoveryClient,
} from '../channels/discord-setup-discovery.js';
import {
  RestDiscordSetupDiscoveryClient,
  trimDiscordSetupCredentials,
} from '../channels/discord-setup-discovery.js';
import { upsertEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import {
  allocateDefaultAgentFolder,
  defaultTriggerForAgentName,
  normalizeDefaultAgentName,
} from './main-agent.js';
import { nowIso } from '../shared/time/datetime.js';
import { PromptProfileService } from '../application/agents/prompt-profile-service.js';
import {
  createProfileFileMirrorExists,
  createProfileFileMirrorWriter,
} from '../platform/profile-file-mirror.js';

type DiscordChannelChoice =
  | { type: 'selected'; channel: DiscordDiscoveredChannel }
  | { type: 'skip' }
  | { type: 'cancel' };

function parseDiscordApproverIds(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export async function registerDiscordMainGroup(options: {
  runtimeHome: string;
  chatJid: string;
  displayName: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  const db = await openRuntimeGroupDb(options.runtimeHome);
  try {
    const existing = await db.getAllConversationRoutes();
    const existingGroup = existing[options.chatJid];
    const folder =
      existingGroup?.folder ||
      allocateDefaultAgentFolder(options.runtimeHome, existing);
    const groupName = normalizeDefaultAgentName(options.displayName);
    const route = {
      name: groupName,
      folder,
      trigger: existingGroup?.trigger || defaultTriggerForAgentName(groupName),
      added_at: existingGroup?.added_at || nowIso(),
      requiresTrigger: false,
      agentConfig: existingGroup?.agentConfig,
    };
    await db.setConversationRoute(options.chatJid, route);
    const settings = loadRuntimeSettings(options.runtimeHome);
    const previousSettings = structuredClone(settings);
    ensureConfiguredConversationBinding(settings, {
      agentId: folder,
      agentName: groupName,
      agentFolder: folder,
      jid: options.chatJid,
      displayName: options.displayName,
      trigger: route.trigger,
      requiresTrigger: false,
    });
    await writeDesiredRuntimeSettings({
      runtimeHome: options.runtimeHome,
      settings,
      previousSettings,
    });
    await new PromptProfileService({
      fileArtifactStore: () => db.getFileArtifactStore(),
      mirrorProfileFile: createProfileFileMirrorWriter(options.runtimeHome),
      mirrorFileExists: createProfileFileMirrorExists(options.runtimeHome),
    }).ensureAgentDefaults({ agentFolder: folder, agentName: groupName });
    return { folder, groupName };
  } finally {
    await db.close();
  }
}

async function promptForValue(options: {
  message: string;
  defaultValue?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
  hide?: boolean;
}): Promise<string | null> {
  const result = options.hide
    ? await p.password({ message: options.message, validate: options.validate })
    : await p.text({
        message: options.message,
        defaultValue: options.defaultValue,
        validate: options.validate,
      });
  if (p.isCancel(result)) return null;
  return String(result).trim();
}

async function chooseDiscordChannelForConnect(
  credentials: DiscordSetupCredentials,
  discoveryClient: DiscordSetupDiscoveryClient,
): Promise<DiscordChannelChoice> {
  const spinner = p.spinner();
  spinner.start('Discovering Discord channels...');
  const discovery = await discoveryClient.listChannels({
    credentials,
    limit: 50,
  });
  if (!discovery.ok || discovery.channels.length === 0) {
    spinner.stop('No Discord channels found for this bot');
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return { type: 'skip' };
  }
  spinner.stop(`Found ${discovery.channels.length} Discord channel(s).`);
  const selected = await p.select({
    message: 'Choose the Discord channel for the Default Agent',
    options: [
      ...discovery.channels.slice(0, 20).map((channel) => ({
        value: channel.chatJid,
        label: channel.chatTitle,
        hint: channel.channelType,
      })),
      { value: 'skip', label: 'Skip registration for now' },
      { value: 'cancel', label: 'Cancel Discord connect' },
    ],
  });
  if (p.isCancel(selected) || selected === 'cancel') return { type: 'cancel' };
  if (selected === 'skip') return { type: 'skip' };
  const channel = discovery.channels.find(
    (entry) => entry.chatJid === selected,
  );
  return channel ? { type: 'selected', channel } : { type: 'skip' };
}

export async function runDiscordConnectCommand(
  runtimeHome: string,
  discoveryClient: DiscordSetupDiscoveryClient = new RestDiscordSetupDiscoveryClient(),
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  p.note(
    [
      'Create or reuse a Discord application and bot.',
      'Install it with bot and applications.commands scopes.',
      'This setup registers a Discord channel and /gantry command.',
      'Docs: https://discord.com/developers/docs',
    ].join('\n'),
    'Discord bot setup',
  );
  const botToken = await promptForValue({
    message: 'Discord bot token',
    hide: true,
    validate: (value) =>
      value?.trim() ? undefined : 'Discord bot token is required.',
  });
  if (botToken === null) return 1;
  const applicationId = await promptForValue({
    message: 'Discord application ID',
    validate: (value) =>
      value?.trim() ? undefined : 'Discord application ID is required.',
  });
  if (applicationId === null) return 1;

  const credentials = trimDiscordSetupCredentials({
    botToken,
    applicationId,
  });
  const validation = await discoveryClient.validateCredentials(credentials);
  if (!validation.ok) {
    p.log.error(validation.message);
    if (validation.nextAction) p.log.info(validation.nextAction);
    return 1;
  }
  p.log.success(validation.message);

  const channelChoice = await chooseDiscordChannelForConnect(
    credentials,
    discoveryClient,
  );
  if (channelChoice.type === 'cancel') return 1;

  let registeredFolder = '';
  let conversationRouteName = '';
  let registeredChatJid = '';
  let registeredChatTitle = '';
  const approverInput =
    channelChoice.type === 'selected'
      ? await promptForValue({
          message:
            'Discord approver user IDs (comma-separated; must be members of this conversation)',
          defaultValue: '',
        })
      : '';
  if (channelChoice.type === 'selected' && approverInput === null) return 1;
  const approverIds = parseDiscordApproverIds(approverInput || '');

  if (channelChoice.type === 'selected') {
    const verified = await discoveryClient.verifyChannel({
      credentials,
      guildId: channelChoice.channel.guildId,
      channelId: channelChoice.channel.channelId,
    });
    if (!verified.ok || !verified.chatJid) {
      p.log.error(verified.message);
      if (verified.nextAction) p.log.info(verified.nextAction);
      return 1;
    }
    const commandRegistration = await discoveryClient.registerGantryCommand({
      credentials,
      guildId: channelChoice.channel.guildId,
    });
    if (!commandRegistration.ok) {
      p.log.error(commandRegistration.message);
      if (commandRegistration.nextAction) {
        p.log.info(commandRegistration.nextAction);
      }
      return 1;
    }
    const registered = await registerDiscordMainGroup({
      runtimeHome,
      chatJid: verified.chatJid,
      displayName: loadRuntimeSettings(runtimeHome).agent.name,
    });
    registeredFolder = registered.folder;
    conversationRouteName = registered.groupName;
    registeredChatJid = verified.chatJid;
    registeredChatTitle = verified.chatTitle || verified.chatJid;
    p.log.success(
      `Registered ${registered.groupName} for Discord channel ${registeredChatTitle} in folder ${registered.folder}.`,
    );
  }

  upsertEnvFile(envFilePath(runtimeHome), {
    DISCORD_BOT_TOKEN: credentials.botToken,
    DISCORD_APPLICATION_ID: credentials.applicationId,
  });
  const settings = loadRuntimeSettings(runtimeHome);
  const previousSettings = structuredClone(settings);
  const previousDiscordEnabled = settings.providers.discord?.enabled ?? false;
  const providerConnectionId =
    settings.providers.discord?.defaultConnection || 'discord_default';
  settings.providers.discord = {
    enabled: channelChoice.type === 'selected' || previousDiscordEnabled,
    defaultConnection: providerConnectionId,
  };
  settings.providerConnections[providerConnectionId] ??= {
    provider: 'discord',
    label: 'Discord Default',
    runtimeSecretRefs: {
      bot_token: 'DISCORD_BOT_TOKEN',
      application_id: 'DISCORD_APPLICATION_ID',
    },
  };
  if (registeredFolder) {
    ensureConfiguredConversationBinding(settings, {
      agentId: registeredFolder,
      agentName: conversationRouteName || settings.agent.name,
      agentFolder: registeredFolder,
      jid: registeredChatJid,
      displayName: registeredChatTitle || conversationRouteName,
      trigger: `@${conversationRouteName || settings.agent.name}`,
      requiresTrigger: false,
      approverIds,
    });
  }
  await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
  });
  p.outro(
    channelChoice.type === 'selected'
      ? 'Discord conversation is configured.'
      : 'Discord credentials saved. Next: run `gantry provider connect discord` to register a conversation.',
  );
  return 0;
}
