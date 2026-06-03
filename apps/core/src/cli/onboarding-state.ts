import fs from 'fs';

import type { HostCredentialMode } from '../config/credentials/mode.js';
import { onboardingStatePath } from '../config/settings/runtime-home.js';
import type { ModelPresetId } from '../shared/model-catalog.js';
import { nowIso } from '../shared/time/datetime.js';

export type OnboardingStep =
  | 'welcome'
  | 'runtime_home'
  | 'storage'
  | 'channel'
  | 'credentials'
  | 'model'
  | 'telegram'
  | 'slack'
  | 'config'
  | 'group'
  | 'verify'
  | 'ready';

export interface OnboardingData {
  runtimeHome: string;
  postgresSetupKind?: 'local' | 'hosted' | 'existing';
  postgresSchema?: string;
  primaryProvider?: 'telegram' | 'slack';
  telegramBotUsername?: string;
  telegramChatJid?: string;
  telegramDisplayName?: string;
  telegramAdminSenderId?: string;
  telegramAdminSenderName?: string;
  telegramPermissionApproverIds?: string;
  slackChatJid?: string;
  slackDisplayName?: string;
  slackPermissionApproverIds?: string;
  memoryEnabled?: boolean;
  embeddingsEnabled?: boolean;
  dreamingEnabled?: boolean;
  credentialMode?: HostCredentialMode;
  agentName?: string;
  modelPreset?: ModelPresetId;
  selectedModel?: string;
  workspaceKey?: string;
  conversationLabel?: string;
}

export interface OnboardingState {
  version: 1;
  status: 'in_progress' | 'completed';
  currentStep: OnboardingStep;
  updatedAt: string;
  data: OnboardingData;
}

export function createInitialState(runtimeHome: string): OnboardingState {
  return {
    version: 1,
    status: 'in_progress',
    currentStep: 'welcome',
    updatedAt: nowIso(),
    data: { runtimeHome },
  };
}

export function readOnboardingState(
  runtimeHome: string,
): OnboardingState | null {
  const filePath = onboardingStatePath(runtimeHome);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    if (parsed.version !== 1) return null;
    if (!parsed.data || typeof parsed.data.runtimeHome !== 'string')
      return null;
    if (parsed.status !== 'in_progress' && parsed.status !== 'completed') {
      return null;
    }
    if (!parsed.currentStep) return null;
    return {
      version: 1,
      status: parsed.status,
      currentStep: parsed.currentStep,
      updatedAt: parsed.updatedAt || nowIso(),
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

export function writeOnboardingState(
  runtimeHome: string,
  state: OnboardingState,
): void {
  const filePath = onboardingStatePath(runtimeHome);
  const next: OnboardingState = {
    ...state,
    version: 1,
    updatedAt: nowIso(),
    data: {
      ...state.data,
      runtimeHome,
    },
  };
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}

export function clearOnboardingState(runtimeHome: string): void {
  const filePath = onboardingStatePath(runtimeHome);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}
