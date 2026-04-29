import fs from 'fs';

import { resolveHostCredentialMode } from '../config/credentials/mode.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import { readEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  settingsFilePath,
} from '../config/settings/runtime-home.js';
import {
  createDefaultRuntimeSettings,
  loadRuntimeSettingsFromPath,
} from '../config/settings/runtime-settings.js';
import {
  DEFAULT_SETUP_MODEL,
  normalizeClaudeModelSelection,
} from '../models/claude-model-registry.js';
import { writeOnboardingState } from './onboarding-state.js';
import type { OnboardingState, OnboardingStep } from './onboarding-state.js';
import { MAIN_AGENT_NAME } from './main-agent.js';

export const FULL_SEQUENCE: OnboardingStep[] = [
  'welcome',
  'runtime_home',
  'storage',
  'prerequisites',
  'channel',
  'telegram',
  'slack',
  'credentials',
  'model',
  'memory',
  'embeddings',
  'dreaming',
  'service',
  'config',
  'group',
  'verify',
  'ready',
];

export type ServiceChoice = 'skip' | 'install' | 'install_start';

export interface SetupDraft {
  runtimeHome: string;
  postgresSetupKind: 'local' | 'hosted' | 'existing';
  postgresDatabaseUrl: string;
  onecliPostgresDatabaseUrl: string;
  postgresSchema: string;
  onecliPostgresSchema: string;
  primaryProvider: 'telegram' | 'slack';
  credentialMode: HostCredentialMode;
  onecliUrl: string;
  agentName: string;
  selectedModel: string;
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
  serviceChoice: ServiceChoice;
  serviceStartedAfterSetup: boolean;
  startAfterSetup: boolean;
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
  if (step === 'telegram' && draft.primaryProvider !== 'telegram') return true;
  if (step === 'slack' && draft.primaryProvider !== 'slack') return true;
  return false;
}

export function updateStateData(
  state: OnboardingState,
  draft: SetupDraft,
): void {
  state.data = {
    runtimeHome: draft.runtimeHome,
    postgresSetupKind: draft.postgresSetupKind,
    postgresSchema: draft.postgresSchema || undefined,
    onecliPostgresSchema: draft.onecliPostgresSchema || undefined,
    primaryProvider: draft.primaryProvider,
    serviceChoice: draft.serviceChoice,
    telegramBotUsername: draft.telegramBotUsername || undefined,
    telegramChatJid: draft.telegramChatJid || undefined,
    telegramAdminSenderId: draft.telegramAdminSenderId || undefined,
    telegramAdminSenderName: draft.telegramAdminSenderName || undefined,
    telegramPermissionApproverIds:
      draft.telegramPermissionApproverIds || undefined,
    slackChatJid: draft.slackChatJid || undefined,
    slackPermissionApproverIds: draft.slackPermissionApproverIds || undefined,
    credentialMode: draft.credentialMode,
    onecliUrl: draft.onecliUrl || undefined,
    agentName: draft.agentName,
    selectedModel: draft.selectedModel || undefined,
    memoryEnabled: draft.memoryEnabled,
    embeddingsEnabled: draft.embeddingsEnabled,
    dreamingEnabled: draft.dreamingEnabled,
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
  draft.serviceChoice = state.data.serviceChoice || draft.serviceChoice;
  draft.telegramBotUsername =
    state.data.telegramBotUsername || draft.telegramBotUsername;
  draft.telegramChatJid = state.data.telegramChatJid || draft.telegramChatJid;
  draft.telegramAdminSenderId =
    state.data.telegramAdminSenderId || draft.telegramAdminSenderId;
  draft.telegramAdminSenderName =
    state.data.telegramAdminSenderName || draft.telegramAdminSenderName;
  draft.telegramPermissionApproverIds =
    state.data.telegramPermissionApproverIds ||
    draft.telegramPermissionApproverIds;
  draft.slackChatJid = state.data.slackChatJid || draft.slackChatJid;
  draft.slackPermissionApproverIds =
    state.data.slackPermissionApproverIds || draft.slackPermissionApproverIds;
  draft.credentialMode = resolveHostCredentialMode(
    state.data.credentialMode || draft.credentialMode,
  );
  draft.onecliUrl = state.data.onecliUrl || draft.onecliUrl;
  draft.agentName = state.data.agentName || draft.agentName;
  draft.selectedModel = state.data.selectedModel || draft.selectedModel;
  draft.memoryEnabled = state.data.memoryEnabled ?? draft.memoryEnabled;
  draft.embeddingsEnabled =
    state.data.embeddingsEnabled ?? draft.embeddingsEnabled;
  draft.dreamingEnabled = state.data.dreamingEnabled ?? draft.dreamingEnabled;
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

export function restoreDraft(
  runtimeHome: string,
  state: OnboardingState | null,
): SetupDraft {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = loadExistingRuntimeSettings(runtimeHome);
  const primaryProvider =
    state?.data.primaryProvider ||
    (settings.channels.slack?.enabled ? 'slack' : 'telegram');
  const credentialMode = resolveHostCredentialMode(
    state?.data.credentialMode || settings.credentialBroker.mode,
  );
  const hasConfiguredChannel = Object.values(settings.channels).some(
    (channel) => channel.enabled,
  );
  const defaultDreamingEnabled = hasConfiguredChannel
    ? settings.memory.dreaming.enabled
    : true;
  const postgresUrlEnv =
    settings.storage.postgres.urlEnv || 'MYCLAW_DATABASE_URL';
  const postgresDatabaseUrl =
    env[postgresUrlEnv]?.trim() || process.env[postgresUrlEnv]?.trim() || '';
  const onecliDatabaseUrlEnv =
    settings.credentialBroker.onecli.postgres.urlEnv || 'ONECLI_DATABASE_URL';
  const onecliPostgresDatabaseUrl =
    env[onecliDatabaseUrlEnv]?.trim() ||
    process.env[onecliDatabaseUrlEnv]?.trim() ||
    '';
  const draft: SetupDraft = {
    runtimeHome,
    postgresSetupKind:
      state?.data.postgresSetupKind ||
      (postgresDatabaseUrl.includes('localhost') ? 'local' : 'existing'),
    postgresDatabaseUrl,
    onecliPostgresDatabaseUrl,
    postgresSchema:
      state?.data.postgresSchema ||
      settings.storage.postgres.schema ||
      'myclaw',
    onecliPostgresSchema:
      state?.data.onecliPostgresSchema ||
      settings.credentialBroker.onecli.postgres.schema ||
      'onecli',
    primaryProvider,
    credentialMode,
    onecliUrl: settings.credentialBroker.onecli.url || '',
    agentName: state?.data.agentName || settings.agent.name || MAIN_AGENT_NAME,
    selectedModel:
      normalizeClaudeModelSelection(
        state?.data.selectedModel || settings.agent.defaultModel,
      ) || DEFAULT_SETUP_MODEL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatJid: '',
    telegramDisplayName: settings.agent.name || MAIN_AGENT_NAME,
    telegramAdminSenderId: '',
    telegramAdminSenderName: '',
    telegramPermissionApproverIds: '',
    telegramBotUsername: '',
    slackBotToken: env.SLACK_BOT_TOKEN || '',
    slackAppToken: env.SLACK_APP_TOKEN || '',
    slackChatJid: '',
    slackDisplayName: settings.agent.name || MAIN_AGENT_NAME,
    slackPermissionApproverIds:
      settings.channels.slack?.controlAllowlist.default.join(',') || '',
    memoryEnabled: state?.data.memoryEnabled ?? settings.memory.enabled,
    embeddingsEnabled:
      state?.data.embeddingsEnabled ?? settings.memory.embeddings.enabled,
    dreamingEnabled: state?.data.dreamingEnabled ?? defaultDreamingEnabled,
    serviceChoice: 'skip',
    serviceStartedAfterSetup: false,
    startAfterSetup: false,
  };
  if (state) updateDraftFromState(draft, state);
  return draft;
}
