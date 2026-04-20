import * as p from '@clack/prompts';

import { resolveHostCredentialMode } from '../core/credential-mode.js';
import type { HostCredentialMode } from '../core/credential-mode.js';
import {
  formatDoctorReport,
  hasRegisteredTelegramGroup,
  hasRuntimeConfig,
  runDoctorWithNetwork,
} from './doctor.js';
import { readEnvFile } from './env-file.js';
import { persistOnboardingConfig } from './onboarding-config.js';
import {
  OnboardingState,
  OnboardingStep,
  clearOnboardingState,
  createInitialState,
  readOnboardingState,
  writeOnboardingState,
} from './onboarding-state.js';
import {
  envFilePath,
  ensureRuntimeWritable,
  resolveRuntimeHome,
  savePreferredRuntimeHome,
} from './runtime-home.js';
import { loadRuntimeSettings } from './runtime-settings.js';
import {
  normalizeTelegramChatJid,
  registerTelegramMainGroup,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from './telegram.js';
import { runCredentialsStep } from './setup-credentials.js';
import { runReadyStep } from './setup-ready.js';
import { installService, startService } from './service-manager.js';

const FULL_SEQUENCE: OnboardingStep[] = [
  'welcome',
  'doctor',
  'runtime_home',
  'prerequisites',
  'credentials',
  'telegram',
  'memory',
  'embeddings',
  'dreaming',
  'config',
  'group',
  'service',
  'verify',
  'ready',
];

type FlowAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'goto'; step: OnboardingStep };

type ServiceChoice = 'skip' | 'install' | 'install_start';

interface SetupDraft {
  runtimeHome: string;
  credentialMode: HostCredentialMode;
  onecliUrl: string;
  telegramBotToken: string;
  telegramChatJid: string;
  telegramDisplayName: string;
  telegramBotUsername: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  openAiApiKey: string;
  serviceChoice: ServiceChoice;
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
}

function toAction(value: unknown): FlowAction {
  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'next') return { type: 'next' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };
  if (typeof value === 'string' && value.startsWith('goto:')) {
    const step = value.slice('goto:'.length) as OnboardingStep;
    return { type: 'goto', step };
  }
  return { type: 'next' };
}

async function chooseProgressAction(options: {
  message: string;
  continueLabel?: string;
  includeBack?: boolean;
}): Promise<FlowAction> {
  const value = await p.select({
    message: options.message,
    options: [
      {
        value: 'next',
        label: options.continueLabel || 'Continue',
      },
      ...(options.includeBack
        ? [
            {
              value: 'back',
              label: 'Back',
            },
          ]
        : []),
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
  });
  return toAction(value);
}

function defaultStepIndex(step: OnboardingStep | undefined): number {
  if (!step) return 0;
  const idx = FULL_SEQUENCE.indexOf(step);
  return idx >= 0 ? idx : 0;
}

function updateStateData(state: OnboardingState, draft: SetupDraft): void {
  state.data = {
    runtimeHome: draft.runtimeHome,
    telegramBotUsername: draft.telegramBotUsername || undefined,
    telegramChatJid: draft.telegramChatJid || undefined,
    credentialMode: draft.credentialMode,
    onecliUrl: draft.onecliUrl || undefined,
    memoryEnabled: draft.memoryEnabled,
    embeddingsEnabled: draft.embeddingsEnabled,
    dreamingEnabled: draft.dreamingEnabled,
  };
}

function persistProgress(state: OnboardingState, runtimeHome: string): void {
  writeOnboardingState(runtimeHome, state);
}

function restoreDraft(
  runtimeHome: string,
  state: OnboardingState | null,
): SetupDraft {
  const env = readEnvFile(envFilePath(runtimeHome));
  const settings = (() => {
    try {
      return loadRuntimeSettings(runtimeHome);
    } catch {
      return {
        channels: {
          telegram: {
            enabled: false,
            senderAllowlist: {
              default: { allow: '*', mode: 'trigger' },
              agents: {},
              logDenied: true,
            },
          },
          slack: {
            enabled: false,
            senderAllowlist: {
              default: { allow: '*', mode: 'trigger' },
              agents: {},
              logDenied: true,
            },
          },
        },
        memory: {
          enabled: true,
          root: 'memory',
          embeddings: {
            enabled: false,
            provider: 'disabled',
            model: 'text-embedding-3-large',
          },
          dreaming: {
            enabled: false,
          },
          llm: {
            models: {
              extractor: 'claude-haiku-4-5-20251001',
              dreaming: 'claude-sonnet-4-6',
              consolidation: 'claude-sonnet-4-6',
              sessionSummary: 'claude-haiku-4-5-20251001',
            },
          },
        },
      };
    }
  })();
  const savedChatJid = state?.data.telegramChatJid || '';
  const savedOnecliUrl = state?.data.onecliUrl || env.ONECLI_URL?.trim() || '';
  const credentialMode = resolveHostCredentialMode(
    state?.data.credentialMode || env.MYCLAW_CREDENTIAL_MODE,
    savedOnecliUrl,
  );
  return {
    runtimeHome,
    credentialMode,
    onecliUrl: savedOnecliUrl,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatJid: savedChatJid,
    telegramDisplayName: 'Telegram Main',
    telegramBotUsername: state?.data.telegramBotUsername || '',
    memoryEnabled: state?.data.memoryEnabled ?? settings.memory.enabled,
    embeddingsEnabled:
      state?.data.embeddingsEnabled ?? settings.memory.embeddings.enabled,
    dreamingEnabled:
      state?.data.dreamingEnabled ?? settings.memory.dreaming.enabled,
    openAiApiKey: env.OPENAI_API_KEY || '',
    serviceChoice: 'skip',
  };
}

async function runWelcomeStep(): Promise<FlowAction> {
  p.note(
    [
      'This setup will connect Telegram and prepare your MyClaw runtime home.',
      'You can go Back, Resume Later, or Cancel at any step.',
    ].join('\n'),
    'Welcome',
  );
  return chooseProgressAction({
    message: 'Start guided setup now?',
    continueLabel: 'Start Setup',
    includeBack: false,
  });
}

async function runDoctorStep(
  importMetaUrl: string,
  runtimeHome: string,
): Promise<FlowAction> {
  const report = await runDoctorWithNetwork(importMetaUrl, runtimeHome);
  p.note(formatDoctorReport(report), 'Machine Doctor');

  if (!report.ok) {
    const action = await p.select({
      message: 'Doctor found blocking issues. What do you want to do?',
      options: [
        {
          value: 'resume',
          label: 'Resume Later (Recommended)',
        },
        {
          value: 'back',
          label: 'Back',
        },
        {
          value: 'cancel',
          label: 'Cancel Setup',
        },
      ],
    });
    return toAction(action);
  }

  return chooseProgressAction({
    message: 'Doctor checks passed. Continue?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

async function runRuntimeHomeStep(
  draft: SetupDraft,
): Promise<{ action: FlowAction; changedHome?: string }> {
  const value = await p.text({
    message: 'Where should MyClaw store runtime data?',
    placeholder: '~/myclaw',
    defaultValue: draft.runtimeHome,
    validate: (input) => {
      if (!input || !input.trim()) {
        return 'Please enter a path (for example: ~/myclaw).';
      }
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    return { action: { type: 'resume' } };
  }

  const resolved = resolveRuntimeHome(String(value));
  try {
    ensureRuntimeWritable(resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      `Cannot write to ${resolved}. Next action: fix permissions or choose another path. (${message})`,
    );
    return { action: { type: 'goto', step: 'runtime_home' } };
  }

  p.note(
    [
      `Runtime home: ${resolved}`,
      'MyClaw will keep .env, settings.yaml, store/, agents/, data/, logs/, and onboarding state here.',
    ].join('\n'),
    'Runtime Home',
  );

  const action = await chooseProgressAction({
    message: 'Use this runtime home?',
    continueLabel: 'Use This Path',
    includeBack: true,
  });
  if (action.type !== 'next') {
    return { action };
  }
  return {
    action,
    changedHome: resolved,
  };
}

async function runPrerequisitesStep(): Promise<FlowAction> {
  p.note(
    [
      'MyClaw runs as a local host process.',
      'Proceed once Node.js and runtime-home checks are passing.',
    ].join('\n'),
    'Runtime Prerequisites',
  );

  return chooseProgressAction({
    message: 'Continue to agent credential setup?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

async function runTelegramStep(draft: SetupDraft): Promise<FlowAction> {
  let token = draft.telegramBotToken;
  while (true) {
    if (token) {
      const tokenChoice = await p.select({
        message: 'Telegram bot token',
        options: [
          {
            value: 'use_saved',
            label: 'Use saved token (Recommended)',
            hint: 'Reuse the token already found in this runtime home.',
          },
          {
            value: 'enter_new',
            label: 'Enter a new token',
            hint: 'Replace the saved token with a new value.',
          },
          {
            value: 'back',
            label: 'Back',
          },
          {
            value: 'resume',
            label: 'Resume Later',
          },
          {
            value: 'cancel',
            label: 'Cancel Setup',
          },
        ],
      });

      if (p.isCancel(tokenChoice)) return { type: 'resume' };
      if (tokenChoice === 'back') return { type: 'back' };
      if (tokenChoice === 'resume') return { type: 'resume' };
      if (tokenChoice === 'cancel') return { type: 'cancel' };
      if (tokenChoice === 'enter_new') token = '';
    }

    if (!token) {
      const entered = await p.password({
        message: 'Paste your Telegram bot token from BotFather',
        validate: (value) => {
          if (!String(value ?? '').trim()) return 'Token is required.';
          return undefined;
        },
      });
      if (p.isCancel(entered)) return { type: 'resume' };
      token = String(entered).trim();
    }

    const spinner = p.spinner();
    spinner.start('Validating token with Telegram...');
    const validation = await validateTelegramBotToken(token);
    if (!validation.ok) {
      spinner.stop('Token check failed');
      p.note(
        `${validation.message}\nNext action: ${validation.nextAction || 'Try again with a valid token.'}`,
        'Token Error',
      );
      const retryChoice = await p.select({
        message: 'What do you want to do?',
        options: [
          { value: 'retry', label: 'Try token again (Recommended)' },
          { value: 'back', label: 'Back' },
          { value: 'resume', label: 'Resume Later' },
          { value: 'cancel', label: 'Cancel Setup' },
        ],
      });
      if (p.isCancel(retryChoice)) return { type: 'resume' };
      if (retryChoice === 'retry') {
        token = '';
        continue;
      }
      if (retryChoice === 'back') return { type: 'back' };
      if (retryChoice === 'resume') return { type: 'resume' };
      return { type: 'cancel' };
    }

    spinner.stop(validation.message);
    draft.telegramBotToken = token;
    draft.telegramBotUsername = validation.username || '';

    const chatInput = await p.text({
      message: 'Enter your Telegram chat ID',
      placeholder: '-1001234567890',
      defaultValue: draft.telegramChatJid.replace(/^tg:/, ''),
      validate: (value) => {
        if (!normalizeTelegramChatJid(String(value ?? ''))) {
          return 'Use a numeric chat ID (for example: -1001234567890).';
        }
        return undefined;
      },
    });
    if (p.isCancel(chatInput)) return { type: 'resume' };

    const normalizedJid = normalizeTelegramChatJid(String(chatInput));
    if (!normalizedJid) {
      p.log.error(
        'Invalid chat ID format. Next action: paste a numeric chat ID.',
      );
      continue;
    }
    draft.telegramChatJid = normalizedJid;

    const chatCheckSpinner = p.spinner();
    chatCheckSpinner.start('Verifying Telegram chat access...');
    const chatAccess = await verifyTelegramChatAccess({
      token,
      chatJid: draft.telegramChatJid,
      botId: validation.botId,
      sendTestMessage: true,
    });
    if (!chatAccess.ok) {
      chatCheckSpinner.stop('Chat access check failed');
      p.note(
        `${chatAccess.message}\nNext action: ${chatAccess.nextAction || 'Fix chat permissions and retry.'}`,
        'Chat Access Error',
      );
      const retryChoice = await p.select({
        message: 'What do you want to do?',
        options: [
          { value: 'retry', label: 'Try again (Recommended)' },
          { value: 'back', label: 'Back' },
          { value: 'resume', label: 'Resume Later' },
          { value: 'cancel', label: 'Cancel Setup' },
        ],
      });
      if (p.isCancel(retryChoice)) return { type: 'resume' };
      if (retryChoice === 'retry') {
        continue;
      }
      if (retryChoice === 'back') return { type: 'back' };
      if (retryChoice === 'resume') return { type: 'resume' };
      return { type: 'cancel' };
    }
    chatCheckSpinner.stop(chatAccess.message);
    if (
      !draft.telegramDisplayName ||
      draft.telegramDisplayName === 'Telegram Main'
    ) {
      draft.telegramDisplayName =
        chatAccess.chatTitle || draft.telegramDisplayName;
    }

    const groupName = await p.text({
      message: 'Choose a name for this Telegram chat in MyClaw',
      defaultValue: draft.telegramDisplayName || 'Telegram Main',
      validate: (value) => {
        if (!String(value ?? '').trim()) return 'Group name is required.';
        return undefined;
      },
    });
    if (p.isCancel(groupName)) return { type: 'resume' };
    draft.telegramDisplayName = String(groupName).trim();

    p.note(
      [
        `Bot: ${draft.telegramBotUsername ? `@${draft.telegramBotUsername}` : 'Configured'}`,
        `Chat: ${draft.telegramChatJid}`,
      ].join('\n'),
      'Telegram',
    );

    return chooseProgressAction({
      message: 'Use these Telegram settings?',
      continueLabel: 'Continue',
      includeBack: true,
    });
  }
}

async function runMemoryStep(draft: SetupDraft): Promise<FlowAction> {
  p.note(
    [
      'Memory stores durable facts, preferences, decisions, corrections, constraints, and procedures.',
      'Continuity uses that memory context to help agents resume current work and open loops instead of starting cold.',
    ].join('\n'),
    'Memory and continuity',
  );
  const value = await p.select({
    message: 'Memory setting',
    options: [
      {
        value: 'on',
        label: 'Keep memory on (Recommended)',
      },
      {
        value: 'off',
        label: 'Turn memory off',
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: draft.memoryEnabled ? 'on' : 'off',
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };

  draft.memoryEnabled = value === 'on';
  return { type: 'next' };
}

async function runEmbeddingsStep(draft: SetupDraft): Promise<FlowAction> {
  if (!draft.memoryEnabled) {
    draft.embeddingsEnabled = false;
    p.note(
      'Embeddings are disabled because memory is currently off.',
      'Embeddings',
    );
    return chooseProgressAction({
      message: 'Continue?',
      continueLabel: 'Continue',
      includeBack: true,
    });
  }

  p.note(
    'Embeddings improve memory search quality using OpenAI. Default is off.',
    'Embeddings',
  );

  const value = await p.select({
    message: 'Embeddings setting',
    options: [
      {
        value: 'off',
        label: 'Keep embeddings off (Recommended)',
      },
      {
        value: 'on',
        label: 'Enable embeddings',
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: draft.embeddingsEnabled ? 'on' : 'off',
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };

  draft.embeddingsEnabled = value === 'on';
  if (!draft.embeddingsEnabled) return { type: 'next' };

  if (!draft.openAiApiKey) {
    const key = await p.password({
      message: 'Paste your OpenAI API key for embeddings',
      validate: (input) => {
        if (!String(input ?? '').trim()) {
          return 'OpenAI API key is required to enable embeddings.';
        }
        return undefined;
      },
    });
    if (p.isCancel(key)) return { type: 'resume' };
    draft.openAiApiKey = String(key).trim();
  }

  return { type: 'next' };
}

async function runDreamingStep(draft: SetupDraft): Promise<FlowAction> {
  p.note(
    'Dreaming runs background memory cleanup and improvement. Default is off.',
    'Dreaming',
  );

  const value = await p.select({
    message: 'Dreaming setting',
    options: [
      {
        value: 'off',
        label: 'Keep dreaming off (Recommended)',
      },
      {
        value: 'on',
        label: 'Enable dreaming',
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: draft.dreamingEnabled ? 'on' : 'off',
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };

  draft.dreamingEnabled = value === 'on';
  return { type: 'next' };
}

async function runConfigStep(draft: SetupDraft): Promise<FlowAction> {
  const spinner = p.spinner();
  spinner.start('Writing runtime config...');
  try {
    ensureRuntimeWritable(draft.runtimeHome);
    persistOnboardingConfig({
      runtimeHome: draft.runtimeHome,
      telegramBotToken: draft.telegramBotToken,
      credentialMode: draft.credentialMode,
      onecliUrl: draft.onecliUrl || undefined,
      memoryEnabled: draft.memoryEnabled,
      embeddingsEnabled: draft.embeddingsEnabled,
      dreamingEnabled: draft.dreamingEnabled,
      openAiApiKey: draft.openAiApiKey || undefined,
    });
    spinner.stop('Runtime config written');
  } catch (err) {
    spinner.stop('Failed to write config');
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      `Could not save config. Next action: fix the issue below and retry setup.\n${message}`,
    );
    return { type: 'resume' };
  }

  return chooseProgressAction({
    message: 'Continue to group creation?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

async function runGroupStep(draft: SetupDraft): Promise<FlowAction> {
  const spinner = p.spinner();
  spinner.start('Creating Telegram group runtime data...');
  try {
    const result = await registerTelegramMainGroup({
      runtimeHome: draft.runtimeHome,
      chatJid: draft.telegramChatJid,
      displayName: draft.telegramDisplayName,
    });
    spinner.stop(`Registered ${result.groupName} (${result.folder})`);
  } catch (err) {
    spinner.stop('Group registration failed');
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      `Could not register Telegram group. Next action: verify chat ID and token, then retry.\n${message}`,
    );
    return {
      type: 'goto',
      step: 'telegram',
    };
  }

  return chooseProgressAction({
    message: 'Continue to optional service setup?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

async function runServiceStep(
  importMetaUrl: string,
  draft: SetupDraft,
): Promise<FlowAction> {
  const choice = await p.select({
    message: 'Background service (optional)',
    options: [
      {
        value: 'skip',
        label: 'Skip for now (Recommended)',
        hint: 'You can run MyClaw manually with `myclaw start`.',
      },
      {
        value: 'install',
        label: 'Install service only',
      },
      {
        value: 'install_start',
        label: 'Install and start service',
      },
      {
        value: 'back',
        label: 'Back',
      },
      {
        value: 'resume',
        label: 'Resume Later',
      },
      {
        value: 'cancel',
        label: 'Cancel Setup',
      },
    ],
    initialValue: draft.serviceChoice,
  });

  if (p.isCancel(choice)) return { type: 'resume' };
  if (choice === 'back') return { type: 'back' };
  if (choice === 'resume') return { type: 'resume' };
  if (choice === 'cancel') return { type: 'cancel' };

  draft.serviceChoice = choice as ServiceChoice;

  if (draft.serviceChoice === 'skip') {
    return { type: 'next' };
  }

  const installOutcome = installService(importMetaUrl, draft.runtimeHome);
  if (!installOutcome.ok) {
    p.log.warn(
      `Service install failed. Next action: run \`myclaw service install\` later.\n${installOutcome.message}`,
    );
    return { type: 'next' };
  }
  p.log.success(installOutcome.message);

  if (draft.serviceChoice === 'install_start') {
    const startOutcome = startService(draft.runtimeHome);
    if (!startOutcome.ok) {
      p.log.warn(
        `Service start failed. Next action: run \`myclaw service start\` later.\n${startOutcome.message}`,
      );
    } else {
      p.log.success(startOutcome.message);
    }
  }

  return { type: 'next' };
}

async function runVerifyStep(
  importMetaUrl: string,
  draft: SetupDraft,
): Promise<FlowAction> {
  const report = await runDoctorWithNetwork(importMetaUrl, draft.runtimeHome);
  const runtimeConfigured = hasRuntimeConfig(draft.runtimeHome);
  const hasTelegramGroup = hasRegisteredTelegramGroup(draft.runtimeHome);

  p.note(formatDoctorReport(report), 'Verification');

  if (!runtimeConfigured || !hasTelegramGroup) {
    p.log.warn(
      'Setup is not complete yet. Next action: reconnect Telegram now.',
    );
    return { type: 'goto', step: 'telegram' };
  }

  if (!report.ok) {
    const action = await p.select({
      message: 'Verification found blocking issues. What next?',
      options: [
        {
          value: 'resume',
          label: 'Resume Later (Recommended)',
        },
        {
          value: 'back',
          label: 'Back',
        },
        {
          value: 'cancel',
          label: 'Cancel Setup',
        },
      ],
    });
    return toAction(action);
  }

  return chooseProgressAction({
    message: 'Verification passed. Continue to ready screen?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

export async function runSetupFlow(
  options: SetupFlowOptions,
): Promise<SetupFlowResult> {
  p.intro(options.title || 'MyClaw Setup');

  let runtimeHome = resolveRuntimeHome(options.runtimeHome);
  let state =
    readOnboardingState(runtimeHome) || createInitialState(runtimeHome);
  const draft = restoreDraft(runtimeHome, state);

  if (runtimeHome !== draft.runtimeHome) {
    runtimeHome = draft.runtimeHome;
  }

  const initialStep = options.initialStep || state.currentStep;
  let index = defaultStepIndex(initialStep);

  while (index < FULL_SEQUENCE.length) {
    const step = FULL_SEQUENCE[index];
    state.currentStep = step;
    state.status = 'in_progress';
    updateStateData(state, draft);
    persistProgress(state, runtimeHome);

    let action: FlowAction = { type: 'next' };

    if (step === 'welcome') {
      action = await runWelcomeStep();
    } else if (step === 'doctor') {
      action = await runDoctorStep(options.importMetaUrl, runtimeHome);
    } else if (step === 'runtime_home') {
      const result = await runRuntimeHomeStep(draft);
      action = result.action;
      if (result.changedHome) {
        const previous = runtimeHome;
        runtimeHome = result.changedHome;
        draft.runtimeHome = runtimeHome;
        state.data.runtimeHome = runtimeHome;
        savePreferredRuntimeHome(runtimeHome);
        if (previous !== runtimeHome) {
          clearOnboardingState(previous);
        }
      }
    } else if (step === 'prerequisites') {
      action = await runPrerequisitesStep();
    } else if (step === 'credentials') {
      action = await runCredentialsStep(draft);
    } else if (step === 'telegram') {
      action = await runTelegramStep(draft);
    } else if (step === 'memory') {
      action = await runMemoryStep(draft);
    } else if (step === 'embeddings') {
      action = await runEmbeddingsStep(draft);
    } else if (step === 'dreaming') {
      action = await runDreamingStep(draft);
    } else if (step === 'config') {
      action = await runConfigStep(draft);
    } else if (step === 'group') {
      action = await runGroupStep(draft);
    } else if (step === 'service') {
      action = await runServiceStep(options.importMetaUrl, draft);
    } else if (step === 'verify') {
      action = await runVerifyStep(options.importMetaUrl, draft);
    } else if (step === 'ready') {
      action = await runReadyStep(draft);
    }

    if (action.type === 'cancel') {
      clearOnboardingState(runtimeHome);
      p.outro('Setup cancelled.');
      return { status: 'cancelled', runtimeHome };
    }

    if (action.type === 'resume') {
      state.currentStep = step;
      state.status = 'in_progress';
      updateStateData(state, draft);
      persistProgress(state, runtimeHome);
      p.outro('Setup paused. Run `myclaw` or `myclaw setup` to resume.');
      return { status: 'resumed', runtimeHome };
    }

    if (action.type === 'goto') {
      const target = FULL_SEQUENCE.indexOf(action.step);
      index = target >= 0 ? target : index;
      continue;
    }

    if (action.type === 'back') {
      index = Math.max(0, index - 1);
      continue;
    }

    index += 1;
  }

  state.status = 'completed';
  state.currentStep = 'ready';
  updateStateData(state, draft);
  persistProgress(state, runtimeHome);
  p.outro('MyClaw is ready.');
  return { status: 'completed', runtimeHome };
}
