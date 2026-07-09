import { styleText } from 'node:util';
import * as p from '@clack/prompts';
import '../channels/register-builtins.js';

import { resolveRuntimeHome } from '../config/settings/runtime-home.js';
import { resolveModelSelectionForWorkload } from '../shared/model-catalog.js';
import {
  clearOnboardingState,
  createInitialState,
  readOnboardingState,
} from './onboarding-state.js';
import type { OnboardingState, OnboardingStep } from './onboarding-state.js';
import { runCredentialsStep } from './setup-credentials.js';
import {
  runChannelStep,
  runMemoryStep,
  runModelStep,
  runRuntimeHomeStep,
  runStorageStep,
  runWelcomeStep,
} from './setup-flow-core-steps.js';
import {
  runConfigStep,
  runGroupStep,
  runVerifyStep,
} from './setup-flow-final-steps.js';
import { runSlackStep, runTelegramStep } from './setup-flow-provider-steps.js';
import {
  defaultStepIndex,
  FULL_SEQUENCE,
  persistProgress,
  restoreDraft,
  shouldAutoSkipAnsweredProviderStep,
  shouldSkipStep,
  updateStateData,
} from './setup-flow-state.js';
export {
  restoreDraft,
  updateStateData,
  type SetupDraft,
} from './setup-flow-state.js';
import { type FlowAction } from './setup-flow-control.js';
import { runReadyStep } from './setup-ready.js';

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

export async function runSetupFlow(
  options: SetupFlowOptions,
): Promise<SetupFlowResult> {
  p.intro(options.title || 'Gantry Setup');

  let runtimeHome = resolveRuntimeHome(options.runtimeHome);
  const state =
    readOnboardingState(runtimeHome) || createInitialState(runtimeHome);
  const draft = restoreDraft(runtimeHome, state);
  const autoSkipState =
    state.status === 'in_progress'
      ? {
          ...state,
          data: { ...state.data },
        }
      : null;

  if (runtimeHome !== draft.runtimeHome) {
    runtimeHome = draft.runtimeHome;
  }

  const initialStep = resolveInitialStep(
    options.initialStep || state.currentStep,
    draft,
  );
  let index = defaultStepIndex(initialStep);
  let explicitStep: OnboardingStep | null = null;

  while (index < FULL_SEQUENCE.length) {
    const step = FULL_SEQUENCE[index];
    const isExplicitStep = explicitStep === step;
    explicitStep = null;
    if (shouldSkipStep(step, draft)) {
      index += 1;
      continue;
    }
    if (
      !isExplicitStep &&
      shouldAutoSkipAnsweredProviderStep(step, draft, autoSkipState)
    ) {
      index += 1;
      continue;
    }
    logStepHeader(step, draft);
    state.currentStep = step;
    state.status = 'in_progress';
    updateStateData(state, draft);
    persistProgress(state, runtimeHome);

    let action: FlowAction = { type: 'next' };

    if (step === 'welcome') {
      action = await runWelcomeStep();
    } else if (step === 'runtime_home') {
      const result = await runRuntimeHomeStep(draft);
      action = result.action;
      if (result.changedHome) {
        const previous = runtimeHome;
        runtimeHome = result.changedHome;
        draft.runtimeHome = runtimeHome;
        state.data.runtimeHome = runtimeHome;
        if (previous !== runtimeHome) {
          clearOnboardingState(previous);
        }
      }
    } else if (step === 'storage') {
      action = await runStorageStep(draft);
    } else if (step === 'channel') {
      action = await runChannelStep(draft);
    } else if (step === 'model') {
      action = await runModelStep(draft);
    } else if (step === 'memory') {
      action = await runMemoryStep(draft);
    } else if (step === 'credentials') {
      action = await runCredentialsStep(draft, runtimeHome);
    } else if (step === 'telegram') {
      action = await runTelegramStep(draft);
    } else if (step === 'slack') {
      action = await runSlackStep(draft);
    } else if (step === 'config') {
      action = await runConfigStep(draft);
    } else if (step === 'group') {
      action = await runGroupStep(draft);
    } else if (step === 'verify') {
      action = await runVerifyStep(options.importMetaUrl, draft);
    } else if (step === 'ready') {
      action = await runReadyStep(draft);
    }

    if (markCompletedProviderStep(state, step, action)) {
      updateStateData(state, draft);
      persistProgress(state, runtimeHome);
    }

    if (action.type === 'cancel') {
      clearOnboardingState(runtimeHome);
      p.outro('Setup cancelled.');
      return { status: 'cancelled', runtimeHome, startAfterSetup: false };
    }

    if (action.type === 'resume') {
      state.currentStep = step;
      state.status = 'in_progress';
      mergeStoredProviderSecretRefs(state, readOnboardingState(runtimeHome));
      updateStateData(state, draft);
      persistProgress(state, runtimeHome);
      p.outro('Setup paused. Run `gantry` or `gantry setup` to resume.');
      return { status: 'resumed', runtimeHome, startAfterSetup: false };
    }

    if (action.type === 'goto') {
      const target = FULL_SEQUENCE.indexOf(action.step);
      index = target >= 0 ? target : index;
      explicitStep = target >= 0 ? action.step : null;
      continue;
    }

    if (action.type === 'start_now') {
      draft.startAfterSetup = true;
      index += 1;
      continue;
    }

    if (action.type === 'back') {
      let previous = index - 1;
      while (previous >= 0 && shouldSkipStep(FULL_SEQUENCE[previous], draft)) {
        previous -= 1;
      }
      index = Math.max(0, previous);
      explicitStep = FULL_SEQUENCE[index] ?? null;
      continue;
    }

    logStepRecap(step, draft, action);
    index += 1;
  }
  state.status = 'completed';
  state.currentStep = 'ready';
  updateStateData(state, draft);
  clearOnboardingState(runtimeHome);
  p.outro('Setup complete.');
  return {
    status: 'completed',
    runtimeHome,
    startAfterSetup: draft.startAfterSetup,
  };
}

function resolveInitialStep(
  initialStep: OnboardingStep,
  draft: ReturnType<typeof restoreDraft>,
): OnboardingStep {
  if (initialStep !== 'config') return initialStep;
  if (
    draft.primaryProvider === 'telegram' &&
    !draft.hasStoredTelegramSecretRefs &&
    !draft.telegramBotToken
  ) {
    return 'telegram';
  }
  if (
    draft.primaryProvider === 'slack' &&
    !draft.hasStoredSlackSecretRefs &&
    (!draft.slackBotToken || !draft.slackAppToken)
  ) {
    return 'slack';
  }
  return initialStep;
}

function markCompletedProviderStep(
  state: OnboardingState,
  step: OnboardingStep,
  action: FlowAction,
): boolean {
  if (action.type !== 'next') return false;
  if (step !== 'telegram' && step !== 'slack') return false;
  const completedProviderSteps = new Set(
    state.data.completedProviderSteps ?? [],
  );
  completedProviderSteps.add(step);
  state.data.completedProviderSteps = [...completedProviderSteps];
  return true;
}

function mergeStoredProviderSecretRefs(
  state: OnboardingState,
  latestState: OnboardingState | null,
): void {
  const latestRefs = latestState?.data.storedProviderSecretRefs;
  if (!latestRefs?.length) return;
  state.data.storedProviderSecretRefs = [
    ...new Set([...(state.data.storedProviderSecretRefs ?? []), ...latestRefs]),
  ];
}

const STEP_DETAILS: Record<OnboardingStep, { label: string; purpose: string }> =
  {
    welcome: {
      label: 'Welcome',
      purpose: 'start guided setup',
    },
    runtime_home: {
      label: 'Runtime home',
      purpose: 'choose where Gantry stores local runtime files',
    },
    storage: {
      label: 'Storage',
      purpose: 'connect Postgres for runtime state',
    },
    channel: {
      label: 'Chat channel',
      purpose: 'choose Telegram or Slack',
    },
    model: {
      label: 'Model',
      purpose: 'choose the main chat model',
    },
    memory: {
      label: 'Memory',
      purpose: 'choose memory and semantic search defaults',
    },
    credentials: {
      label: 'Model credentials',
      purpose: 'store required model access',
    },
    telegram: {
      label: 'Telegram',
      purpose: 'connect bot and chat',
    },
    slack: {
      label: 'Slack',
      purpose: 'connect app and conversation',
    },
    config: {
      label: 'Review',
      purpose: 'write runtime config',
    },
    group: {
      label: 'Conversation',
      purpose: 'create runtime conversation binding',
    },
    verify: {
      label: 'Verify',
      purpose: 'check runtime readiness',
    },
    ready: {
      label: 'Ready',
      purpose: 'finish setup',
    },
  };

function visibleSteps(
  draft: ReturnType<typeof restoreDraft>,
): OnboardingStep[] {
  return FULL_SEQUENCE.filter(
    (candidate) =>
      candidate !== 'welcome' &&
      candidate !== 'ready' &&
      !shouldSkipStep(candidate, draft),
  );
}

function logStepHeader(
  step: OnboardingStep,
  draft: ReturnType<typeof restoreDraft>,
): void {
  const steps = visibleSteps(draft);
  const position = steps.indexOf(step);
  if (position < 0) return;
  const details = STEP_DETAILS[step];
  p.log.step(
    `Step ${position + 1}/${steps.length} · ${details.label} — ${details.purpose}`,
  );
}

function logStepRecap(
  step: OnboardingStep,
  draft: ReturnType<typeof restoreDraft>,
  action: FlowAction,
): void {
  if (action.type !== 'next') return;
  const recap = stepRecap(step, draft);
  if (recap) {
    p.log.message(styleText('dim', recap), {
      symbol: styleText('dim', '✓'),
      spacing: 0,
    });
  }
}

function stepRecap(
  step: OnboardingStep,
  draft: ReturnType<typeof restoreDraft>,
): string | null {
  const providerLabel =
    draft.primaryProvider === 'slack' ? 'Slack' : 'Telegram';
  const selectedModel = resolveModelSelectionForWorkload(
    draft.selectedModel,
    'chat',
  );
  const modelProvider = selectedModel.ok
    ? selectedModel.entry.modelRoute.label
    : 'unknown';
  const recaps: Partial<Record<OnboardingStep, string>> = {
    runtime_home: `Runtime home: ${draft.runtimeHome}`,
    storage: `Storage: ${draft.postgresSetupKind} Postgres (${draft.postgresSchema})`,
    channel: `Chat channel: ${providerLabel}`,
    model: `Model: ${draft.selectedModel} (${modelProvider})`,
    memory: draft.memoryEnabled
      ? `Memory: on; semantic search ${draft.embeddingsEnabled ? 'on' : 'off'}`
      : 'Memory: off',
    credentials: 'Model credentials: checked',
    telegram: `Telegram: ${draft.telegramDisplayName || draft.telegramChatJid}`,
    slack: `Slack: ${draft.slackDisplayName || draft.slackChatJid}`,
    config: 'Config: written',
    group: `Conversation: ${draft.conversationLabel || draft.workspaceKey}`,
    verify: 'Verify: passed',
  };
  return recaps[step] || null;
}
