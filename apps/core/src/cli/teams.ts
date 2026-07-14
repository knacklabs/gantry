import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import type {
  TeamsDiscoveredChannel,
  TeamsSetupCredentials,
  TeamsSetupDiscoveryClient,
} from '../channels/teams-setup-discovery.js';
import {
  GraphTeamsSetupDiscoveryClient,
  trimTeamsSetupCredentials,
} from '../channels/teams-setup-discovery.js';
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

type TeamsChannelChoice =
  | { type: 'selected'; channel: TeamsDiscoveredChannel }
  | { type: 'skip' }
  | { type: 'cancel' };

function parseTeamsApproverIds(raw: string | undefined): string[] {
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

export async function registerTeamsMainGroup(options: {
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
    ? await p.password({
        message: options.message,
        validate: options.validate,
      })
    : await p.text({
        message: options.message,
        defaultValue: options.defaultValue,
        validate: options.validate,
      });
  if (p.isCancel(result)) return null;
  return String(result).trim();
}

async function promptManualTeamsChannel(
  credentials: TeamsSetupCredentials,
  discoveryClient: TeamsSetupDiscoveryClient,
): Promise<TeamsChannelChoice> {
  const teamId = await promptForValue({
    message: 'Teams team ID',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams team ID is required.',
  });
  if (teamId === null) return { type: 'cancel' };
  const channelId = await promptForValue({
    message: 'Teams channel ID (for example 19:...@thread.tacv2)',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams channel ID is required.',
  });
  if (channelId === null) return { type: 'cancel' };
  const verified = await discoveryClient.verifyChannel({
    credentials,
    teamId,
    channelId,
  });
  if (!verified.ok || !verified.chatJid) {
    p.log.error(verified.message);
    if (verified.nextAction) p.log.info(verified.nextAction);
    return { type: 'cancel' };
  }
  return {
    type: 'selected',
    channel: {
      chatJid: verified.chatJid,
      chatTitle: verified.chatTitle || verified.chatJid,
      teamId: verified.teamId || teamId,
      teamName: verified.teamName || teamId,
      channelId: verified.channelId || channelId,
      channelName: verified.channelName || channelId,
      channelType: verified.channelType || 'standard',
    },
  };
}

async function chooseTeamsChannelForConnect(
  credentials: TeamsSetupCredentials,
  discoveryClient: TeamsSetupDiscoveryClient,
): Promise<TeamsChannelChoice> {
  const spinner = p.spinner();
  spinner.start('Discovering Teams channels...');
  const discovery = await discoveryClient.listChannels({
    credentials,
    limit: 50,
  });
  if (!discovery.ok) {
    spinner.stop('Could not auto-discover Teams channels');
    p.log.info(discovery.message);
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualTeamsChannel(credentials, discoveryClient);
  }
  if (discovery.channels.length === 0) {
    spinner.stop('No Teams channels found for this app');
    if (discovery.nextAction) p.log.info(discovery.nextAction);
    return promptManualTeamsChannel(credentials, discoveryClient);
  }

  spinner.stop(`Found ${discovery.channels.length} Teams channel(s).`);
  const selected = await p.select({
    message: 'Choose the Teams channel for the Default Agent',
    options: [
      ...discovery.channels.slice(0, 20).map((channel) => ({
        value: channel.chatJid,
        label: channel.chatTitle,
        hint: channel.channelType,
      })),
      { value: 'manual', label: 'Enter team/channel IDs manually' },
      { value: 'skip', label: 'Skip registration for now' },
      { value: 'cancel', label: 'Cancel Teams connect' },
    ],
  });
  if (p.isCancel(selected) || selected === 'cancel') {
    return { type: 'cancel' };
  }
  if (selected === 'manual') {
    return promptManualTeamsChannel(credentials, discoveryClient);
  }
  if (selected === 'skip') return { type: 'skip' };
  const channel = discovery.channels.find(
    (entry) => entry.chatJid === selected,
  );
  return channel ? { type: 'selected', channel } : { type: 'skip' };
}

export async function runTeamsConnectCommand(
  runtimeHome: string,
  discoveryClient: TeamsSetupDiscoveryClient = new GraphTeamsSetupDiscoveryClient(),
  requestedAgentId?: string,
  requestedAgentName?: string,
): Promise<number> {
  ensureRuntimeLayout(runtimeHome);
  const requestedAgentDisplayName = requestedAgentName?.trim();
  p.note(
    [
      'Create or reuse a Microsoft Entra app for Teams Graph discovery.',
      'Grant Microsoft Graph application permissions for reading Teams and channels, then complete tenant admin consent.',
      'Configure the Azure Bot messaging endpoint to point at Gantry: POST /v1/providers/teams/activities.',
      'Docs: https://learn.microsoft.com/en-us/graph/teams-concept-overview',
    ].join('\n'),
    'Teams app setup',
  );

  const clientId = await promptForValue({
    message: 'Teams client ID',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams client ID is required.',
  });
  if (clientId === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const clientSecret = await promptForValue({
    message: 'Teams client secret',
    hide: true,
    validate: (value) =>
      value?.trim() ? undefined : 'Teams client secret is required.',
  });
  if (clientSecret === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const tenantId = await promptForValue({
    message: 'Teams tenant ID',
    validate: (value) =>
      value?.trim() ? undefined : 'Teams tenant ID is required.',
  });
  if (tenantId === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }

  const credentials = trimTeamsSetupCredentials({
    clientId,
    clientSecret,
    tenantId,
  });
  const validation = await discoveryClient.validateCredentials(credentials);
  if (!validation.ok) {
    p.log.error(validation.message);
    if (validation.nextAction) p.log.info(validation.nextAction);
    return 1;
  }
  p.log.success(validation.message);

  const clientIdSecret = await planRuntimeSecretInput({
    runtimeHome,
    name: 'TEAMS_CLIENT_ID',
    value: credentials.clientId,
    actor: 'cli:teams-connect',
    label: 'Teams client ID',
  });
  if (!clientIdSecret) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const clientSecretRef = await planRuntimeSecretInput({
    runtimeHome,
    name: 'TEAMS_CLIENT_SECRET',
    value: credentials.clientSecret,
    actor: 'cli:teams-connect',
    label: 'Teams client secret',
  });
  if (!clientSecretRef) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const tenantIdSecret = await planRuntimeSecretInput({
    runtimeHome,
    name: 'TEAMS_TENANT_ID',
    value: credentials.tenantId,
    actor: 'cli:teams-connect',
    label: 'Teams tenant ID',
  });
  if (!tenantIdSecret) {
    p.outro('Teams connect cancelled.');
    return 1;
  }

  const channelChoice = await chooseTeamsChannelForConnect(
    credentials,
    discoveryClient,
  );
  if (channelChoice.type === 'cancel') {
    p.outro('Teams connect cancelled.');
    return 1;
  }

  let registeredFolder = '';
  let conversationRouteName = '';
  let registeredChatJid = '';
  let registeredChatTitle = '';
  const approverInput =
    channelChoice.type === 'selected'
      ? await promptForValue({
          message:
            'Teams admin/approver user IDs (comma-separated; seeds this conversation approvers; must be members of this conversation)',
          defaultValue: '',
        })
      : '';
  if (channelChoice.type === 'selected' && approverInput === null) {
    p.outro('Teams connect cancelled.');
    return 1;
  }
  const approverIds = parseTeamsApproverIds(approverInput || '');

  if (channelChoice.type === 'selected') {
    const currentSettings = loadRuntimeSettings(runtimeHome);
    const verified = await discoveryClient.verifyChannel({
      credentials,
      teamId: channelChoice.channel.teamId,
      channelId: channelChoice.channel.channelId,
    });
    if (!verified.ok || !verified.chatJid) {
      p.log.error(verified.message);
      if (verified.nextAction) p.log.info(verified.nextAction);
      return 1;
    }
    const registered = await registerTeamsMainGroup({
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
      `Registered ${registered.groupName} for Teams conversation ${registeredChatTitle} in folder ${registered.folder}.`,
    );
  }

  await Promise.all([
    clientIdSecret.persist(),
    clientSecretRef.persist(),
    tenantIdSecret.persist(),
  ]);
  const settings = loadRuntimeSettings(runtimeHome);
  const previousSettings = structuredClone(settings);
  settings.providers.teams.enabled = true;
  let providerAccountId = 'teams_default';
  // The registered route's owner wins: reusing an existing conversation
  // must not hand its provider account to the requesting agent.
  const providerAgentId =
    registeredFolder || requestedAgentId || DEFAULT_AGENT_FOLDER;
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
      providerId: 'teams',
      agentId: providerAgentId,
      defaultAccountId: providerAccountId,
    });
  }
  settings.providerAccounts[providerAccountId] = {
    agentId: providerAgentId,
    provider: 'teams',
    label:
      settings.providerAccounts[providerAccountId]?.label || 'Teams Default',
    runtimeSecretRefs: {
      ...(settings.providerAccounts[providerAccountId]?.runtimeSecretRefs ||
        {}),
      client_id: clientIdSecret.ref,
      client_secret: clientSecretRef.ref,
      tenant_id: tenantIdSecret.ref,
    },
  };
  await writeDesiredRuntimeSettings({
    runtimeHome,
    settings,
    previousSettings,
  });

  if (channelChoice.type === 'selected') {
    p.outro('Teams connected. Secret stored encrypted in Gantry.');
  } else {
    p.outro(
      'Teams connected. Secret stored encrypted in Gantry. Next: run `gantry provider connect teams` to register a conversation.',
    );
  }
  return 0;
}
