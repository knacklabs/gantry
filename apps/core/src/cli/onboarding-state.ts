import fs from 'fs';

import type { HostCredentialMode } from '../core/credential-mode.js';
import { onboardingStatePath } from './runtime-home.js';

export type OnboardingStep =
  | 'welcome'
  | 'doctor'
  | 'runtime_home'
  | 'prerequisites'
  | 'credentials'
  | 'telegram'
  | 'memory'
  | 'embeddings'
  | 'dreaming'
  | 'config'
  | 'group'
  | 'service'
  | 'verify'
  | 'ready';

export interface OnboardingData {
  runtimeHome: string;
  telegramBotUsername?: string;
  telegramChatJid?: string;
  memoryEnabled?: boolean;
  memoryProvider?: 'sqlite' | 'qmd' | 'noop';
  embeddingsEnabled?: boolean;
  dreamingEnabled?: boolean;
  credentialMode?: HostCredentialMode;
  onecliUrl?: string;
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
    updatedAt: new Date().toISOString(),
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
      updatedAt: parsed.updatedAt || new Date().toISOString(),
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
    updatedAt: new Date().toISOString(),
    data: {
      ...state.data,
      runtimeHome,
    },
  };
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}

export function clearOnboardingState(runtimeHome: string): void {
  const filePath = onboardingStatePath(runtimeHome);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}
