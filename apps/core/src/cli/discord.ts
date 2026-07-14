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
import { ensureRuntimeLayout } from '../config/settings/runtime-home.js';
import {
  ensureConfiguredAgent,
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { openRuntimeGroupDb } from './runtime-group-db.js';
import {
  allocateDefaultAgentFolder,
  DEFAULT_AGENT_FOLDER,
  defaultTriggerForAgentName,
  normalizeDefaultAgentName,
} from './main-agent.js';
import { nowIso } from '../shared/time/datetime.js';
import { PromptProfileService } from '../application/agents/prompt-profile-service.js';
import {
  createProfileFileMirrorExists,
  createProfileFileMirrorWriter,
} from '../platform/profile-file-mirror.js';
import { planRuntimeSecretInput } from './runtime-secret-ref-prompt.js';
import { providerAccountIdForAgent } from './provider-utils.js';

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
  agentId?: string;
}): Promise<{ folder: string; groupName: string }> {
  ensureRuntimeLayout(options.runtimeHome);
  const db = await openRuntimeGroupDb(options.runtimeHome);
  try {
    const existing = await db.getAllConversationRoutes();
    const existingGroup = existing[options.chatJid];
    // An already-registered conversation keeps its owning agent; agentId
    // only binds conversations that are not routed yet.
    const folder =
      existingGroup?.folder ||
      options.agentId?.trim() ||
      allocateDefaultAgentFolder(options.runtimeHome, existing);
    // A conversation owned by a DIFFERENT agent than the requested one is
    // reused as-is: rewriting its display name would rename someone else's
    // route with no rollback path in the route DB.
    const requestedAgentId = options.agentId?.trim();
    const keepExistingRoute = Boolean(
      existingGroup &&
      requestedAgentId &&
      existingGroup.folder !== requestedAgentId,
    );
    const groupName = keepExistingRoute
      ? existingGroup!.name
      : normalizeDefaultAgentName(options.displayName);
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
  requestedAgentId?: string,
  requestedAgentName?: string,
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  const requestedAgentDisplayName = requestedAgentName?.trim();
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

  const botSecret = await planRuntimeSecretInput({
    runtimeHome,
    name: 'DISCORD_BOT_TOKEN',
    value: credentials.botToken,
    actor: 'cli:discord-connect',
    label: 'Discord bot token',
  });
  if (!botSecret) return 1;
  const applicationSecret = await planRuntimeSecretInput({
    runtimeHome,
    name: 'DISCORD_APPLICATION_ID',
    value: credentials.applicationId,
    actor: 'cli:discord-connect',
    label: 'Discord application ID',
  });
  if (!applicationSecret) return 1;

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
    const currentSettings = loadRuntimeSettings(runtimeHome);
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
      displayName:
        (requestedAgentId && currentSettings.agents[requestedAgentId]?.name) ||
        requestedAgentDisplayName ||
        currentSettings.agent.name,
      agentId: requestedAgentId,
    });
    registeredFolder = registered.folder;
    conversationRouteName = registered.groupName;
    registeredChatJid = verified.chatJid;
    registeredChatTitle = verified.chatTitle || verified.chatJid;
    p.log.success(
      `Registered ${registered.groupName} for Discord channel ${registeredChatTitle} in folder ${registered.folder}.`,
    );
  }

  await Promise.all([botSecret.persist(), applicationSecret.persist()]);
  const settings = loadRuntimeSettings(runtimeHome);
  const previousSettings = structuredClone(settings);
  const previousDiscordEnabled = settings.providers.discord?.enabled ?? false;
  let providerAccountId = 'discord_default';
  // The registered route's owner wins: reusing an existing conversation
  // must not hand its provider account to the requesting agent.
  const providerAgentId =
    registeredFolder || requestedAgentId || DEFAULT_AGENT_FOLDER;
  settings.providers.discord = {
    enabled: channelChoice.type === 'selected' || previousDiscordEnabled,
  };
  ensureConfiguredAgent(settings, {
    agentId: providerAgentId,
    agentName:
      settings.agents[providerAgentId]?.name ||
      requestedAgentDisplayName ||
      registeredChatTitle ||
      settings.agent.name,
    agentFolder: providerAgentId,
  });
  if (registeredFolder) {
    const binding = ensureConfiguredConversationBinding(settings, {
      agentId: registeredFolder,
      agentName: conversationRouteName || settings.agent.name,
      agentFolder: registeredFolder,
      jid: registeredChatJid,
      displayName: registeredChatTitle || conversationRouteName,
      trigger: `@${conversationRouteName || settings.agent.name}`,
      requiresTrigger: false,
      approverIds,
    });
    providerAccountId = binding.providerConnectionId;
  } else {
    providerAccountId = providerAccountIdForAgent(settings, {
      providerId: 'discord',
      agentId: providerAgentId,
      defaultAccountId: providerAccountId,
    });
  }
  settings.providerAccounts[providerAccountId] = {
    agentId: providerAgentId,
    provider: 'discord',
    label:
      settings.providerAccounts[providerAccountId]?.label || 'Discord Default',
    runtimeSecretRefs: {
      ...(settings.providerAccounts[providerAccountId]?.runtimeSecretRefs ||
        {}),
      bot_token: botSecret.ref,
      application_id: applicationSecret.ref,
    },
  };
  await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
  });
  p.outro(
    channelChoice.type === 'selected'
      ? 'Discord connected. Secret stored encrypted in Gantry.'
      : 'Discord connected. Secret stored encrypted in Gantry. Next: run `gantry provider connect discord` to register a conversation.',
  );
  return 0;
}
