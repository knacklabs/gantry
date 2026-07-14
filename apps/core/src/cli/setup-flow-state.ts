import fs from 'fs';

import { resolveHostCredentialMode } from '../config/credentials/mode.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import { readEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  settingsFilePath,
} from '../config/settings/runtime-home.js';
import {
  AUTO_AGENT_HARNESS,
  isAgentHarness,
  type AgentHarness,
} from '../shared/agent-engine.js';
import {
  createDefaultRuntimeSettings,
  loadRuntimeSettingsFromPath,
} from '../config/settings/runtime-settings.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  resolveModelAlias,
} from '../shared/model-catalog.js';
import { writeOnboardingState } from './onboarding-state.js';
import type { OnboardingState, OnboardingStep } from './onboarding-state.js';
import { DEFAULT_AGENT_CLI_NAME } from './main-agent.js';

export const FULL_SEQUENCE: OnboardingStep[] = [
  'welcome',
  'runtime_home',
  'storage',
  'channel',
  'model',
  'memory',
  'credentials',
  'telegram',
  'slack',
  'config',
  'group',
  'verify',
  'ready',
];

export interface SetupDraft {
  runtimeHome: string;
  postgresSetupKind: 'local' | 'hosted' | 'existing';
  postgresDatabaseUrl: string;
  postgresSchema: string;
  primaryProvider: 'telegram' | 'slack';
  credentialMode: HostCredentialMode;
  agentName: string;
  selectedModel: string;
  agentHarness: AgentHarness;
  credentialLiveSkipProviderIds: string[];
  telegramBotToken: string;
  telegramChatJid: string;
  telegramDisplayName: string;
  telegramAdminSenderId: string;
  telegramAdminSenderName: string;
  telegramPermissionApproverIds: string;
  telegramBotUsername: string;
  slackBotToken: string;
  slackAppToken: string;
  slackChatJid: string;
  slackDisplayName: string;
  slackPermissionApproverIds: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  workspaceKey: string;
  conversationLabel: string;
  startAfterSetup: boolean;
  maintenanceMode: boolean;
  hasConfiguredChannelBinding: boolean;
  hasStoredTelegramSecretRefs: boolean;
  hasStoredSlackSecretRefs: boolean;
}

export interface SetupFlowOptions {
  importMetaUrl: string;
  runtimeHome: string;
  initialStep?: OnboardingStep;
  title?: string;
}

export interface SetupFlowResult {
  status: 'completed' | 'resumed' | 'cancelled';
  runtimeHome: string;
  startAfterSetup: boolean;
}

export function defaultStepIndex(step: OnboardingStep | undefined): number {
  if (!step) return 0;
  const idx = FULL_SEQUENCE.indexOf(step);
  return idx >= 0 ? idx : 0;
}

export function shouldSkipStep(
  step: OnboardingStep,
  draft: SetupDraft,
): boolean {
  if (
    draft.maintenanceMode &&
    draft.hasConfiguredChannelBinding &&
    (step === 'channel' ||
      step === 'telegram' ||
      step === 'slack' ||
      step === 'group')
  ) {
    return true;
  }
  if (step === 'telegram' && draft.primaryProvider !== 'telegram') return true;
  if (step === 'slack' && draft.primaryProvider !== 'slack') return true;
  return false;
}

export function shouldAutoSkipAnsweredProviderStep(
  step: OnboardingStep,
  draft: SetupDraft,
  state: OnboardingState | null,
): boolean {
  const savedTelegramAnswer = Boolean(
    state?.status === 'in_progress' &&
    state.data.completedProviderSteps?.includes('telegram') &&
    state.data.telegramChatJid &&
    state.data.telegramPermissionApproverIds,
  );
  const savedSlackAnswer = Boolean(
    state?.status === 'in_progress' &&
    state.data.completedProviderSteps?.includes('slack') &&
    state.data.slackChatJid &&
    state.data.slackPermissionApproverIds,
  );
  if (
    step === 'telegram' &&
    draft.primaryProvider === 'telegram' &&
    savedTelegramAnswer &&
    draft.hasStoredTelegramSecretRefs &&
    draft.telegramChatJid &&
    draft.telegramPermissionApproverIds
  ) {
    return true;
  }
  if (
    step === 'slack' &&
    draft.primaryProvider === 'slack' &&
    savedSlackAnswer &&
    draft.hasStoredSlackSecretRefs &&
    draft.slackChatJid &&
    draft.slackPermissionApproverIds
  ) {
    return true;
  }
  return false;
}

export function updateStateData(
  state: OnboardingState,
  draft: SetupDraft,
): void {
  const completedProviderSteps = state.data.completedProviderSteps?.length
    ? state.data.completedProviderSteps
    : undefined;
  const storedProviderSecretRefs = state.data.storedProviderSecretRefs?.length
    ? state.data.storedProviderSecretRefs
    : undefined;
  state.data = {
    runtimeHome: draft.runtimeHome,
    postgresSetupKind: draft.postgresSetupKind,
    postgresSchema: draft.postgresSchema || undefined,
    primaryProvider: draft.primaryProvider,
    telegramBotUsername: draft.telegramBotUsername || undefined,
    telegramChatJid: draft.telegramChatJid || undefined,
    telegramDisplayName: draft.telegramDisplayName || undefined,
    telegramAdminSenderId: draft.telegramAdminSenderId || undefined,
    telegramAdminSenderName: draft.telegramAdminSenderName || undefined,
    telegramPermissionApproverIds:
      draft.telegramPermissionApproverIds || undefined,
    slackChatJid: draft.slackChatJid || undefined,
    slackDisplayName: draft.slackDisplayName || undefined,
    slackPermissionApproverIds: draft.slackPermissionApproverIds || undefined,
    credentialMode: draft.credentialMode,
    agentName: draft.agentName,
    selectedModel: draft.selectedModel || undefined,
    agentHarness: draft.agentHarness,
    credentialLiveSkipProviderIds: draft.credentialLiveSkipProviderIds?.length
      ? draft.credentialLiveSkipProviderIds
      : undefined,
    workspaceKey: draft.workspaceKey || undefined,
    conversationLabel: draft.conversationLabel || undefined,
    memoryEnabled: draft.memoryEnabled,
    embeddingsEnabled: draft.embeddingsEnabled,
    dreamingEnabled: draft.dreamingEnabled,
    maintenanceMode: draft.maintenanceMode || undefined,
    completedProviderSteps,
    storedProviderSecretRefs,
  };
}

export function updateDraftFromState(
  draft: SetupDraft,
  state: OnboardingState,
): void {
  draft.runtimeHome = state.data.runtimeHome || draft.runtimeHome;
  draft.postgresSetupKind =
    state.data.postgresSetupKind || draft.postgresSetupKind;
  draft.primaryProvider = state.data.primaryProvider || draft.primaryProvider;
  draft.telegramBotUsername =
    state.data.telegramBotUsername || draft.telegramBotUsername;
  draft.telegramChatJid = state.data.telegramChatJid || draft.telegramChatJid;
  draft.telegramDisplayName =
    state.data.telegramDisplayName || draft.telegramDisplayName;
  draft.telegramAdminSenderId =
    state.data.telegramAdminSenderId || draft.telegramAdminSenderId;
  draft.telegramAdminSenderName =
    state.data.telegramAdminSenderName || draft.telegramAdminSenderName;
  draft.telegramPermissionApproverIds =
    state.data.telegramPermissionApproverIds ||
    draft.telegramPermissionApproverIds;
  draft.slackChatJid = state.data.slackChatJid || draft.slackChatJid;
  draft.slackDisplayName =
    state.data.slackDisplayName || draft.slackDisplayName;
  draft.slackPermissionApproverIds =
    state.data.slackPermissionApproverIds || draft.slackPermissionApproverIds;
  draft.credentialMode = resolveHostCredentialMode(
    state.data.credentialMode || draft.credentialMode,
  );
  draft.agentName = state.data.agentName || draft.agentName;
  draft.selectedModel =
    resolveModelAlias(state.data.selectedModel) || draft.selectedModel;
  draft.agentHarness = isAgentHarness(state.data.agentHarness)
    ? state.data.agentHarness
    : draft.agentHarness;
  draft.credentialLiveSkipProviderIds =
    state.data.credentialLiveSkipProviderIds ??
    draft.credentialLiveSkipProviderIds;
  draft.workspaceKey = state.data.workspaceKey || draft.workspaceKey;
  draft.conversationLabel =
    state.data.conversationLabel || draft.conversationLabel;
  draft.memoryEnabled = state.data.memoryEnabled ?? draft.memoryEnabled;
  draft.embeddingsEnabled =
    state.data.embeddingsEnabled ?? draft.embeddingsEnabled;
  draft.dreamingEnabled = state.data.dreamingEnabled ?? draft.dreamingEnabled;
  draft.maintenanceMode = state.data.maintenanceMode ?? draft.maintenanceMode;
}

export function persistProgress(
  state: OnboardingState,
  runtimeHome: string,
): void {
  writeOnboardingState(runtimeHome, state);
}

function loadExistingRuntimeSettings(runtimeHome: string) {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) {
    return createDefaultRuntimeSettings();
  }
  try {
    return loadRuntimeSettingsFromPath(filePath);
  } catch {
    return createDefaultRuntimeSettings();
  }
}

const REQUIRED_CHANNEL_SECRET_REFS = {
  telegram: ['bot_token'],
  slack: ['bot_token', 'app_token'],
} as const;

function hasEnabledProviderWithStoredSecretRefs(
  settings: ReturnType<typeof loadExistingRuntimeSettings>,
  providerId: SetupDraft['primaryProvider'],
): boolean {
  if (!settings.providers[providerId]?.enabled) return false;
  return Object.values(settings.providerAccounts).some(
    (account) =>
      account.provider === providerId &&
      account.status !== 'disabled' &&
      REQUIRED_CHANNEL_SECRET_REFS[providerId].every((key) =>
        Boolean(account.runtimeSecretRefs[key]?.trim()),
      ),
  );
}

export function restoreDraft(
  runtimeHome: string,
  state: OnboardingState | null,
): SetupDraft {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = loadExistingRuntimeSettings(runtimeHome);
  const primaryProvider =
    state?.data.primaryProvider ||
    (settings.providers.slack?.enabled ? 'slack' : 'telegram');
  const credentialMode = resolveHostCredentialMode(
    state?.data.credentialMode || settings.credentialBroker.mode,
  );
  const hasConfiguredProvider = Object.values(settings.providers).some(
    (provider) => provider.enabled,
  );
  const defaultDreamingEnabled = hasConfiguredProvider
    ? settings.memory.dreaming.enabled
    : true;
  const postgresUrlEnv =
    settings.storage.postgres.urlEnv || 'GANTRY_DATABASE_URL';
  const postgresDatabaseUrl =
    env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
  const readySummary = resolveReadySummary(settings, primaryProvider);
  const hasConfiguredChannelBinding = Boolean(
    settings.providers[primaryProvider]?.enabled &&
    readySummary.conversationJid,
  );
  const hasStoredTelegramSecretRefs =
    hasEnabledProviderWithStoredSecretRefs(settings, 'telegram') ||
    Boolean(state?.data.storedProviderSecretRefs?.includes('telegram'));
  const hasStoredSlackSecretRefs =
    hasEnabledProviderWithStoredSecretRefs(settings, 'slack') ||
    Boolean(state?.data.storedProviderSecretRefs?.includes('slack'));
  const draft: SetupDraft = {
    runtimeHome,
    postgresSetupKind:
      state?.data.postgresSetupKind ||
      (postgresDatabaseUrl.includes('localhost') ? 'local' : 'existing'),
    postgresDatabaseUrl,
    postgresSchema:
      state?.data.postgresSchema ||
      settings.storage.postgres.schema ||
      'gantry',
    primaryProvider,
    credentialMode,
    agentName:
      state?.data.agentName || settings.agent.name || DEFAULT_AGENT_CLI_NAME,
    selectedModel:
      resolveModelAlias(
        state?.data.selectedModel || settings.agent.defaultModel,
      ) || DEFAULT_SETUP_MODEL_ALIAS,
    agentHarness: isAgentHarness(state?.data.agentHarness)
      ? state.data.agentHarness
      : settings.agent.agentHarness || AUTO_AGENT_HARNESS,
    credentialLiveSkipProviderIds:
      state?.data.credentialLiveSkipProviderIds ?? [],
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatJid:
      primaryProvider === 'telegram' ? readySummary.conversationJid : '',
    telegramDisplayName: settings.agent.name || DEFAULT_AGENT_CLI_NAME,
    telegramAdminSenderId: '',
    telegramAdminSenderName: '',
    telegramPermissionApproverIds: '',
    telegramBotUsername: '',
    slackBotToken: env.SLACK_BOT_TOKEN || '',
    slackAppToken: env.SLACK_APP_TOKEN || '',
    slackChatJid:
      primaryProvider === 'slack' ? readySummary.conversationJid : '',
    slackDisplayName: settings.agent.name || DEFAULT_AGENT_CLI_NAME,
    slackPermissionApproverIds: firstConversationApprovers(
      settings,
      'slack',
    ).join(','),
    memoryEnabled: state?.data.memoryEnabled ?? settings.memory.enabled,
    embeddingsEnabled:
      state?.data.embeddingsEnabled ?? settings.memory.embeddings.enabled,
    dreamingEnabled: state?.data.dreamingEnabled ?? defaultDreamingEnabled,
    workspaceKey: readySummary.workspaceKey,
    conversationLabel: readySummary.conversationLabel,
    startAfterSetup: false,
    maintenanceMode: state?.data.maintenanceMode ?? false,
    hasConfiguredChannelBinding,
    hasStoredTelegramSecretRefs,
    hasStoredSlackSecretRefs,
  };
  if (state) updateDraftFromState(draft, state);
  return draft;
}

function resolveReadySummary(
  settings: ReturnType<typeof loadExistingRuntimeSettings>,
  providerId: string,
): Pick<SetupDraft, 'workspaceKey' | 'conversationLabel'> & {
  conversationJid: string;
} {
  for (const [agentId, agent] of Object.entries(settings.agents)) {
    for (const binding of Object.values(agent.bindings)) {
      if (binding.provider !== providerId) continue;
      return {
        workspaceKey: agent.folder || agentId,
        conversationLabel: binding.name || binding.jid,
        conversationJid: binding.jid,
      };
    }
  }
  return { workspaceKey: '', conversationLabel: '', conversationJid: '' };
}

function firstConversationApprovers(
  settings: ReturnType<typeof loadExistingRuntimeSettings>,
  providerId: string,
): string[] {
  for (const conversation of Object.values(settings.conversations)) {
    const connection = settings.providerAccounts[conversation.providerAccount];
    if (connection?.provider === providerId) {
      return conversation.controlApprovers;
    }
  }
  return [];
}
