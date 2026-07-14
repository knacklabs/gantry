import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  clearOnboardingState,
  createInitialState,
  readOnboardingState,
  writeOnboardingState,
} from '@core/cli/onboarding-state.js';

describe('cli onboarding-state helpers', () => {
  it('writes and reads onboarding state', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-state-'));
    const state = createInitialState(runtimeHome);
    state.currentStep = 'telegram';
    state.data.telegramChatJid = 'tg:-1001';

    writeOnboardingState(runtimeHome, state);

    const loaded = readOnboardingState(runtimeHome);
    expect(loaded).not.toBeNull();
    expect(loaded?.currentStep).toBe('telegram');
    expect(loaded?.data.telegramChatJid).toBe('tg:-1001');

    fs.rmSync(runtimeHome, { recursive: true, force: true });
  });

  it('clears onboarding state file', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-state-'));
    writeOnboardingState(runtimeHome, createInitialState(runtimeHome));

    clearOnboardingState(runtimeHome);

    const loaded = readOnboardingState(runtimeHome);
    expect(loaded).toBeNull();

    fs.rmSync(runtimeHome, { recursive: true, force: true });
  });

  it('persists the memory onboarding step', () => {
    const runtimeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-state-'));
    const state = createInitialState(runtimeHome);
    state.currentStep = 'memory';

    writeOnboardingState(runtimeHome, state);

    expect(readOnboardingState(runtimeHome)?.currentStep).toBe('memory');

    fs.rmSync(runtimeHome, { recursive: true, force: true });
  });
});
