import * as p from '@clack/prompts';
import '../channels/register-builtins.js';

import { resolveRuntimeHome } from '../config/settings/runtime-home.js';
import {
  clearOnboardingState,
  createInitialState,
  readOnboardingState,
} from './onboarding-state.js';
import type { OnboardingStep } from './onboarding-state.js';
import { runCredentialsStep } from './setup-credentials.js';
import {
  runChannelStep,
  runModelStep,
  runPrerequisitesStep,
  runRuntimeHomeStep,
  runStorageStep,
  runWelcomeStep,
} from './setup-flow-core-steps.js';
import {
  applyServiceChoice,
  applyServiceStartChoice,
  runConfigStep,
  runDreamingStep,
  runEmbeddingsStep,
  runGroupStep,
  runMemoryStep,
  runServiceStep,
  runVerifyStep,
} from './setup-flow-final-steps.js';
import { runSlackStep, runTelegramStep } from './setup-flow-provider-steps.js';
import {
  defaultStepIndex,
  FULL_SEQUENCE,
  persistProgress,
  restoreDraft,
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

  if (runtimeHome !== draft.runtimeHome) {
    runtimeHome = draft.runtimeHome;
  }

  const initialStep = options.initialStep || state.currentStep;
  let index = defaultStepIndex(initialStep);

  while (index < FULL_SEQUENCE.length) {
    const step = FULL_SEQUENCE[index];
    if (shouldSkipStep(step, draft)) {
      index += 1;
      continue;
    }
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
    } else if (step === 'prerequisites') {
      action = await runPrerequisitesStep();
    } else if (step === 'channel') {
      action = await runChannelStep(draft);
    } else if (step === 'credentials') {
      action = await runCredentialsStep(draft, runtimeHome);
    } else if (step === 'model') {
      action = await runModelStep(draft);
    } else if (step === 'telegram') {
      action = await runTelegramStep(draft);
    } else if (step === 'slack') {
      action = await runSlackStep(draft);
    } else if (step === 'memory') {
      action = await runMemoryStep(draft);
    } else if (step === 'embeddings') {
      action = await runEmbeddingsStep(draft);
    } else if (step === 'dreaming') {
      action = await runDreamingStep(draft);
    } else if (step === 'service') {
      action = await runServiceStep(draft);
    } else if (step === 'config') {
      action = await runConfigStep(draft);
    } else if (step === 'group') {
      action = await runGroupStep(draft);
      if (action.type === 'next') {
        await applyServiceChoice(options.importMetaUrl, draft);
      }
    } else if (step === 'verify') {
      action = await runVerifyStep(options.importMetaUrl, draft);
      if (action.type === 'next') {
        await applyServiceStartChoice(draft);
      }
    } else if (step === 'ready') {
      action = await runReadyStep(draft);
    }

    if (action.type === 'cancel') {
      clearOnboardingState(runtimeHome);
      p.outro('Setup cancelled.');
      return { status: 'cancelled', runtimeHome, startAfterSetup: false };
    }

    if (action.type === 'resume') {
      state.currentStep = step;
      state.status = 'in_progress';
      updateStateData(state, draft);
      persistProgress(state, runtimeHome);
      p.outro('Setup paused. Run `gantry` or `gantry setup` to resume.');
      return { status: 'resumed', runtimeHome, startAfterSetup: false };
    }

    if (action.type === 'goto') {
      const target = FULL_SEQUENCE.indexOf(action.step);
      index = target >= 0 ? target : index;
      continue;
    }

    if (action.type === 'start_now') {
      draft.startAfterSetup = !draft.serviceStartedAfterSetup;
      index += 1;
      continue;
    }

    if (action.type === 'back') {
      let previous = index - 1;
      while (previous >= 0 && shouldSkipStep(FULL_SEQUENCE[previous], draft)) {
        previous -= 1;
      }
      index = Math.max(0, previous);
      continue;
    }

    index += 1;
  }
  state.status = 'completed';
  state.currentStep = 'ready';
  updateStateData(state, draft);
  clearOnboardingState(runtimeHome);
  p.outro('Gantry is ready.');
  return {
    status: 'completed',
    runtimeHome,
    startAfterSetup: draft.startAfterSetup,
  };
}
