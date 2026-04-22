import * as p from '@clack/prompts';
import '../channels/register-builtins.js';
import { listChannelProviders } from '../channels/provider-registry.js';

import { resolveHostCredentialMode } from '../core/credential-mode.js';
import type { HostCredentialMode } from '../core/credential-mode.js';
import {
  formatDoctorReport,
  hasProcessableGroupForConfiguredChannel,
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
} from './runtime-home.js';
import {
  createDefaultRuntimeSettings,
  loadRuntimeSettings,
} from './runtime-settings.js';
import {
  normalizeTelegramChatJid,
  registerTelegramMainGroup,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from './telegram.js';
import { listTelegramRecentChats } from './telegram-chat-discovery.js';
import { runCredentialsStep } from './setup-credentials.js';
import { runReadyStep } from './setup-ready.js';
import { installService, startService } from './service-manager.js';
import {
  normalizeSlackChatJid,
  registerSlackMainGroup,
  validateSlackAppToken,
  validateSlackBotToken,
  verifySlackChatAccess,
} from './slack.js';
import { listSlackRecentChats } from './slack-chat-discovery.js';

const FULL_SEQUENCE: OnboardingStep[] = [
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
  'config',
  'group',
  'service',
  'verify',
  'ready',
];

type FlowAction =
  | { type: 'next' }
  | { type: 'start_now' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' }
  | { type: 'goto'; step: OnboardingStep };

type ServiceChoice = 'skip' | 'install' | 'install_start';

interface SetupDraft {
  runtimeHome: string;
  storageProvider: 'sqlite';
  primaryProvider: 'telegram' | 'slack';
  credentialMode: HostCredentialMode;
  onecliUrl: string;
  selectedModel: string;
  claudeOauthToken: string;
  anthropicApiKey: string;
  telegramBotToken: string;
  telegramChatJid: string;
  telegramDisplayName: string;
  telegramBotUsername: string;
  slackBotToken: string;
  slackAppToken: string;
  slackChatJid: string;
  slackDisplayName: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  openAiApiKey: string;
  serviceChoice: ServiceChoice;
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

function toAction(value: unknown): FlowAction {
  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'next') return { type: 'next' };
  if (value === 'start_now') return { type: 'start_now' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };
  if (typeof value === 'string' && value.startsWith('goto:')) {
    const step = value.slice('goto:'.length) as OnboardingStep;
    return { type: 'goto', step };
  }
  return { type: 'next' };
}

function isInputFlowControl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '/back' ||
    normalized === '/resume' ||
    normalized === '/cancel'
  );
}

function parseInputFlowControl(value: unknown): FlowAction | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '/back') return { type: 'back' };
  if (normalized === '/resume') return { type: 'resume' };
  if (normalized === '/cancel') return { type: 'cancel' };
  return null;
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

function shouldSkipStep(step: OnboardingStep, draft: SetupDraft): boolean {
  if (step === 'telegram' && draft.primaryProvider !== 'telegram') return true;
  if (step === 'slack' && draft.primaryProvider !== 'slack') return true;
  return false;
}

function updateStateData(state: OnboardingState, draft: SetupDraft): void {
  state.data = {
    runtimeHome: draft.runtimeHome,
    primaryProvider: draft.primaryProvider,
    storageProvider: draft.storageProvider,
    telegramBotUsername: draft.telegramBotUsername || undefined,
    telegramChatJid: draft.telegramChatJid || undefined,
    slackChatJid: draft.slackChatJid || undefined,
    credentialMode: draft.credentialMode,
    onecliUrl: draft.onecliUrl || undefined,
    selectedModel: draft.selectedModel || undefined,
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
      return createDefaultRuntimeSettings();
    }
  })();
  const savedTelegramChatJid = state?.data.telegramChatJid || '';
  const savedSlackChatJid = state?.data.slackChatJid || '';
  const savedOnecliUrl = state?.data.onecliUrl || env.ONECLI_URL?.trim() || '';
  const primaryProvider =
    state?.data.primaryProvider ||
    (settings.channels.slack?.enabled ? 'slack' : 'telegram');
  const credentialMode = resolveHostCredentialMode(
    state?.data.credentialMode || env.MYCLAW_CREDENTIAL_MODE,
    savedOnecliUrl,
  );
  const hasConfiguredChannel = Object.values(settings.channels).some(
    (channel) => channel.enabled,
  );
  const defaultDreamingEnabled = hasConfiguredChannel
    ? settings.memory.dreaming.enabled
    : true;
  return {
    runtimeHome,
    storageProvider: 'sqlite',
    primaryProvider,
    credentialMode,
    onecliUrl: savedOnecliUrl,
    selectedModel:
      state?.data.selectedModel || env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatJid: savedTelegramChatJid,
    telegramDisplayName: 'Telegram Main',
    telegramBotUsername: state?.data.telegramBotUsername || '',
    slackBotToken: env.SLACK_BOT_TOKEN || '',
    slackAppToken: env.SLACK_APP_TOKEN || '',
    slackChatJid: savedSlackChatJid,
    slackDisplayName: 'Slack Main',
    memoryEnabled: state?.data.memoryEnabled ?? settings.memory.enabled,
    embeddingsEnabled:
      state?.data.embeddingsEnabled ?? settings.memory.embeddings.enabled,
    dreamingEnabled: state?.data.dreamingEnabled ?? defaultDreamingEnabled,
    openAiApiKey: env.OPENAI_API_KEY || '',
    serviceChoice: 'skip',
    startAfterSetup: false,
  };
}

async function runWelcomeStep(): Promise<FlowAction> {
  p.note(
    [
      'This setup will connect your first channel and prepare your MyClaw runtime home.',
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

async function runRuntimeHomeStep(
  draft: SetupDraft,
): Promise<{ action: FlowAction; changedHome?: string }> {
  const defaultRuntimeHome = draft.runtimeHome || '~/myclaw';
  const value = await p.text({
    message: 'Where should MyClaw store runtime data?',
    placeholder: '~/myclaw',
    defaultValue: defaultRuntimeHome,
    validate: (input) => {
      if ((!input || !input.trim()) && !defaultRuntimeHome) {
        return 'Please enter a path (for example: ~/myclaw).';
      }
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    return { action: { type: 'resume' } };
  }

  const resolved = resolveRuntimeHome(
    String(value).trim() || defaultRuntimeHome,
  );
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

async function runStorageStep(draft: SetupDraft): Promise<FlowAction> {
  p.note(
    [
      'Choose where MyClaw stores runtime state.',
      'SQLite is the production-ready host runtime database today.',
      'Postgres is intentionally not offered here until runtime persistence is fully provider-backed.',
    ].join('\n'),
    'Storage',
  );

  const provider = await p.select({
    message: 'Choose storage backend',
    options: [
      {
        value: 'sqlite',
        label: 'SQLite (Recommended)',
        hint: 'Zero-config local DB under runtime home.',
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
    initialValue: draft.storageProvider,
  });

  if (p.isCancel(provider)) return { type: 'resume' };
  if (provider === 'back') return { type: 'back' };
  if (provider === 'resume') return { type: 'resume' };
  if (provider === 'cancel') return { type: 'cancel' };

  draft.storageProvider = 'sqlite';
  return { type: 'next' };
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
    message: 'Continue to provider selection?',
    continueLabel: 'Continue',
    includeBack: true,
  });
}

async function runChannelStep(draft: SetupDraft): Promise<FlowAction> {
  const value = await p.select({
    message: 'Choose your first channel provider',
    options: [
      {
        value: 'telegram',
        label: 'Telegram (Recommended)',
        hint: 'Bot token from BotFather + chat auto-discovery.',
      },
      {
        value: 'slack',
        label: 'Slack',
        hint: 'Bot token + app token + conversation auto-discovery.',
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
    initialValue: draft.primaryProvider,
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };

  draft.primaryProvider = value === 'slack' ? 'slack' : 'telegram';
  return { type: 'next' };
}

async function runModelStep(draft: SetupDraft): Promise<FlowAction> {
  const value = await p.select({
    message: 'Choose main model',
    options: [
      {
        value: 'claude-sonnet-4-6',
        label: 'Sonnet (Recommended)',
        hint: 'Balanced speed/cost/quality.',
      },
      {
        value: 'claude-opus-4-1-20250805',
        label: 'Opus',
        hint: 'Higher quality, slower and more expensive.',
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
    initialValue: draft.selectedModel || 'claude-sonnet-4-6',
  });

  if (p.isCancel(value)) return { type: 'resume' };
  if (value === 'back') return { type: 'back' };
  if (value === 'resume') return { type: 'resume' };
  if (value === 'cancel') return { type: 'cancel' };
  draft.selectedModel = String(value);
  return { type: 'next' };
}

async function runTelegramStep(draft: SetupDraft): Promise<FlowAction> {
  if (draft.primaryProvider !== 'telegram') {
    return { type: 'next' };
  }
  p.note(
    [
      '1. Open Telegram and start a chat with @BotFather.',
      '2. Send /newbot, choose a display name, then choose a username ending in "bot".',
      '3. Copy the token BotFather returns and paste it here.',
      '4. For a group: add the bot to the group, send a message in that group, then retry discovery.',
      '5. If group discovery or message pickup is inconsistent, make the bot an admin or disable Group Privacy in BotFather with /setprivacy.',
      'Docs: https://core.telegram.org/bots/faq',
    ].join('\n'),
    'Telegram bot setup',
  );
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
        message:
          'Paste your Telegram bot token from BotFather (/back, /resume, /cancel)',
        validate: (value) => {
          const trimmed = String(value ?? '').trim();
          if (isInputFlowControl(trimmed)) return undefined;
          if (!trimmed) return 'Token is required.';
          return undefined;
        },
      });
      if (p.isCancel(entered)) return { type: 'resume' };
      const control = parseInputFlowControl(entered);
      if (control) return control;
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

    let normalizedJid = '';
    const discoverySpinner = p.spinner();
    discoverySpinner.start('Looking for recent Telegram chats...');
    const discovered = await listTelegramRecentChats({
      token,
      limit: 30,
    });
    if (discovered.ok && discovered.chats.length > 0) {
      discoverySpinner.stop(
        `Found ${discovered.chats.length} recent Telegram chat(s).`,
      );
      const selected = await p.select({
        message: 'Choose the Telegram chat for MyClaw',
        options: [
          ...discovered.chats.slice(0, 15).map((chat) => ({
            value: chat.chatJid,
            label: `${chat.chatTitle} (${chat.chatJid.replace(/^tg:/, '')})`,
            hint: chat.chatType,
          })),
          {
            value: 'manual',
            label: 'Enter chat ID manually',
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
      if (p.isCancel(selected)) return { type: 'resume' };
      if (selected === 'back') return { type: 'back' };
      if (selected === 'resume') return { type: 'resume' };
      if (selected === 'cancel') return { type: 'cancel' };
      if (selected === 'manual') {
        const defaultChatId = draft.telegramChatJid.replace(/^tg:/, '');
        const chatInput = await p.text({
          message: 'Enter your Telegram chat ID (/back, /resume, /cancel)',
          placeholder: '-1001234567890',
          defaultValue: defaultChatId,
          validate: (value) => {
            const trimmed = String(value ?? '').trim();
            if (isInputFlowControl(trimmed)) return undefined;
            if (!trimmed && defaultChatId) return undefined;
            if (!normalizeTelegramChatJid(trimmed)) {
              return 'Use a numeric chat ID (for example: -1001234567890).';
            }
            return undefined;
          },
        });
        if (p.isCancel(chatInput)) return { type: 'resume' };
        const control = parseInputFlowControl(chatInput);
        if (control) return control;
        normalizedJid =
          normalizeTelegramChatJid(String(chatInput).trim() || defaultChatId) ||
          '';
      } else {
        normalizedJid = normalizeTelegramChatJid(String(selected)) || '';
      }
    } else {
      discoverySpinner.stop('No recent Telegram chat found.');
      if (discovered.nextAction) p.log.info(discovered.nextAction);
      const defaultChatId = draft.telegramChatJid.replace(/^tg:/, '');
      const chatInput = await p.text({
        message: 'Enter your Telegram chat ID (/back, /resume, /cancel)',
        placeholder: '-1001234567890',
        defaultValue: defaultChatId,
        validate: (value) => {
          const trimmed = String(value ?? '').trim();
          if (isInputFlowControl(trimmed)) return undefined;
          if (!trimmed && defaultChatId) return undefined;
          if (!normalizeTelegramChatJid(trimmed)) {
            return 'Use a numeric chat ID (for example: -1001234567890).';
          }
          return undefined;
        },
      });
      if (p.isCancel(chatInput)) return { type: 'resume' };
      const control = parseInputFlowControl(chatInput);
      if (control) return control;
      normalizedJid =
        normalizeTelegramChatJid(String(chatInput).trim() || defaultChatId) ||
        '';
    }

    if (!normalizedJid) {
      p.log.error(
        'Invalid chat ID format. Next action: use a numeric Telegram chat ID.',
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

    const defaultGroupName = draft.telegramDisplayName || 'Telegram Main';
    const groupName = await p.text({
      message:
        'Choose a name for this Telegram chat in MyClaw (/back, /resume, /cancel)',
      defaultValue: defaultGroupName,
      validate: (value) => {
        const trimmed = String(value ?? '').trim();
        if (isInputFlowControl(trimmed)) return undefined;
        if (!trimmed && defaultGroupName) return undefined;
        if (!trimmed) return 'Group name is required.';
        return undefined;
      },
    });
    if (p.isCancel(groupName)) return { type: 'resume' };
    const groupNameControl = parseInputFlowControl(groupName);
    if (groupNameControl) return groupNameControl;
    draft.telegramDisplayName = String(groupName).trim() || defaultGroupName;

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

async function runSlackStep(draft: SetupDraft): Promise<FlowAction> {
  if (draft.primaryProvider !== 'slack') {
    return { type: 'next' };
  }
  p.note(
    [
      '1. Create a Slack app from app settings for the target workspace.',
      '2. Add a bot user and bot scopes for posting, conversation discovery, and message events.',
      '   Minimum practical scopes: chat:write, app_mentions:read, channels:read, groups:read, im:read, mpim:read, plus message history scopes for the conversation types you want MyClaw to read.',
      '3. Enable Socket Mode and generate an app-level token with connections:write.',
      '4. Install or reinstall the app to the workspace after scope changes.',
      '5. Invite the app to the target channel or DM it once before discovery.',
      'Docs: https://docs.slack.dev/apis/events-api/using-socket-mode/',
    ].join('\n'),
    'Slack app setup',
  );

  let botToken = draft.slackBotToken;
  while (true) {
    if (botToken) {
      const tokenChoice = await p.select({
        message: 'Slack bot token',
        options: [
          {
            value: 'use_saved',
            label: 'Use saved token (Recommended)',
            hint: 'Reuse the token already found in this runtime home.',
          },
          {
            value: 'enter_new',
            label: 'Enter a new bot token',
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
      if (tokenChoice === 'enter_new') botToken = '';
    }

    if (!botToken) {
      const entered = await p.password({
        message:
          'Paste your Slack bot token (xoxb-...) (/back, /resume, /cancel)',
        validate: (value) => {
          const trimmed = String(value ?? '').trim();
          if (isInputFlowControl(trimmed)) return undefined;
          return trimmed ? undefined : 'Slack bot token is required.';
        },
      });
      if (p.isCancel(entered)) return { type: 'resume' };
      const control = parseInputFlowControl(entered);
      if (control) return control;
      botToken = String(entered).trim();
    }

    const botValidation = await validateSlackBotToken(botToken);
    if (!botValidation.ok) {
      p.note(
        `${botValidation.message}\nNext action: ${botValidation.nextAction || 'Try again with a valid token.'}`,
        'Bot Token Error',
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
        botToken = '';
        continue;
      }
      if (retryChoice === 'back') return { type: 'back' };
      if (retryChoice === 'resume') return { type: 'resume' };
      return { type: 'cancel' };
    }
    draft.slackBotToken = botToken;
    p.log.success(botValidation.message);

    let appToken = draft.slackAppToken;
    if (appToken) {
      const appChoice = await p.select({
        message: 'Slack app token',
        options: [
          {
            value: 'use_saved',
            label: 'Use saved token (Recommended)',
          },
          {
            value: 'enter_new',
            label: 'Enter a new app token',
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
      if (p.isCancel(appChoice)) return { type: 'resume' };
      if (appChoice === 'back') return { type: 'back' };
      if (appChoice === 'resume') return { type: 'resume' };
      if (appChoice === 'cancel') return { type: 'cancel' };
      if (appChoice === 'enter_new') appToken = '';
    }

    if (!appToken) {
      const entered = await p.password({
        message:
          'Paste your Slack app token (xapp-...) for Socket Mode (/back, /resume, /cancel)',
        validate: (value) => {
          const trimmed = String(value ?? '').trim();
          if (isInputFlowControl(trimmed)) return undefined;
          return trimmed ? undefined : 'Slack app token is required.';
        },
      });
      if (p.isCancel(entered)) return { type: 'resume' };
      const control = parseInputFlowControl(entered);
      if (control) return control;
      appToken = String(entered).trim();
    }

    const appValidation = await validateSlackAppToken(appToken);
    if (!appValidation.ok) {
      p.note(
        `${appValidation.message}\nNext action: ${appValidation.nextAction || 'Try again with a valid app token.'}`,
        'App Token Error',
      );
      const retryChoice = await p.select({
        message: 'What do you want to do?',
        options: [
          { value: 'retry', label: 'Try app token again (Recommended)' },
          { value: 'back', label: 'Back' },
          { value: 'resume', label: 'Resume Later' },
          { value: 'cancel', label: 'Cancel Setup' },
        ],
      });
      if (p.isCancel(retryChoice)) return { type: 'resume' };
      if (retryChoice === 'retry') {
        draft.slackAppToken = '';
        continue;
      }
      if (retryChoice === 'back') return { type: 'back' };
      if (retryChoice === 'resume') return { type: 'resume' };
      return { type: 'cancel' };
    }
    draft.slackAppToken = appToken;
    p.log.success(appValidation.message);

    let normalizedJid = '';
    const discoverySpinner = p.spinner();
    discoverySpinner.start('Looking for accessible Slack conversations...');
    const discovered = await listSlackRecentChats({ botToken, limit: 100 });
    if (discovered.ok && discovered.chats.length > 0) {
      discoverySpinner.stop(`Found ${discovered.chats.length} conversations.`);
      const selected = await p.select({
        message: 'Choose the Slack conversation for MyClaw',
        options: [
          ...discovered.chats.slice(0, 20).map((chat) => ({
            value: chat.chatJid,
            label: `${chat.chatTitle} (${chat.chatJid.replace(/^sl:/, '')})`,
            hint: chat.chatType,
          })),
          {
            value: 'manual',
            label: 'Enter conversation ID manually',
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
      if (p.isCancel(selected)) return { type: 'resume' };
      if (selected === 'back') return { type: 'back' };
      if (selected === 'resume') return { type: 'resume' };
      if (selected === 'cancel') return { type: 'cancel' };
      if (selected === 'manual') {
        const defaultChatId = draft.slackChatJid.replace(/^sl:/, '');
        const chatInput = await p.text({
          message: 'Enter Slack conversation ID (/back, /resume, /cancel)',
          placeholder: 'C0123456789',
          defaultValue: defaultChatId,
          validate: (value) => {
            const trimmed = String(value ?? '').trim();
            if (isInputFlowControl(trimmed)) return undefined;
            if (!trimmed && defaultChatId) return undefined;
            if (!normalizeSlackChatJid(trimmed)) {
              return 'Use a valid Slack conversation ID (C..., G..., D...).';
            }
            return undefined;
          },
        });
        if (p.isCancel(chatInput)) return { type: 'resume' };
        const control = parseInputFlowControl(chatInput);
        if (control) return control;
        normalizedJid =
          normalizeSlackChatJid(String(chatInput).trim() || defaultChatId) ||
          '';
      } else {
        normalizedJid = normalizeSlackChatJid(String(selected)) || '';
      }
    } else {
      discoverySpinner.stop('No accessible Slack conversation found.');
      if (discovered.nextAction) p.log.info(discovered.nextAction);
      const defaultChatId = draft.slackChatJid.replace(/^sl:/, '');
      const chatInput = await p.text({
        message: 'Enter Slack conversation ID (/back, /resume, /cancel)',
        placeholder: 'C0123456789',
        defaultValue: defaultChatId,
        validate: (value) => {
          const trimmed = String(value ?? '').trim();
          if (isInputFlowControl(trimmed)) return undefined;
          if (!trimmed && defaultChatId) return undefined;
          if (!normalizeSlackChatJid(trimmed)) {
            return 'Use a valid Slack conversation ID (C..., G..., D...).';
          }
          return undefined;
        },
      });
      if (p.isCancel(chatInput)) return { type: 'resume' };
      const control = parseInputFlowControl(chatInput);
      if (control) return control;
      normalizedJid =
        normalizeSlackChatJid(String(chatInput).trim() || defaultChatId) || '';
    }

    if (!normalizedJid) {
      p.log.error(
        'Invalid conversation ID format. Next action: use a valid Slack conversation ID.',
      );
      continue;
    }
    draft.slackChatJid = normalizedJid;

    const access = await verifySlackChatAccess({
      botToken,
      chatJid: draft.slackChatJid,
      sendTestMessage: true,
    });
    if (!access.ok) {
      p.note(
        `${access.message}\nNext action: ${access.nextAction || 'Fix channel access and retry.'}`,
        'Conversation Access Error',
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
    if (!draft.slackDisplayName || draft.slackDisplayName === 'Slack Main') {
      draft.slackDisplayName = access.chatTitle || draft.slackDisplayName;
    }

    const defaultGroupName = draft.slackDisplayName || 'Slack Main';
    const groupName = await p.text({
      message:
        'Choose a name for this Slack chat in MyClaw (/back, /resume, /cancel)',
      defaultValue: defaultGroupName,
      validate: (value) => {
        const trimmed = String(value ?? '').trim();
        if (isInputFlowControl(trimmed)) return undefined;
        if (!trimmed && defaultGroupName) return undefined;
        if (!trimmed) return 'Group name is required.';
        return undefined;
      },
    });
    if (p.isCancel(groupName)) return { type: 'resume' };
    const groupNameControl = parseInputFlowControl(groupName);
    if (groupNameControl) return groupNameControl;
    draft.slackDisplayName = String(groupName).trim() || defaultGroupName;

    p.note(
      [
        `Conversation: ${draft.slackChatJid}`,
        `Name: ${draft.slackDisplayName}`,
      ].join('\n'),
      'Slack',
    );
    return chooseProgressAction({
      message: 'Use these Slack settings?',
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
      'Default is enabled.',
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
      message:
        'Paste your OpenAI API key for embeddings (/back, /resume, /cancel)',
      validate: (input) => {
        const trimmed = String(input ?? '').trim();
        if (isInputFlowControl(trimmed)) return undefined;
        if (!trimmed) {
          return 'OpenAI API key is required to enable embeddings.';
        }
        return undefined;
      },
    });
    if (p.isCancel(key)) return { type: 'resume' };
    const control = parseInputFlowControl(key);
    if (control) return control;
    draft.openAiApiKey = String(key).trim();
  }

  return { type: 'next' };
}

async function runDreamingStep(draft: SetupDraft): Promise<FlowAction> {
  if (!draft.memoryEnabled) {
    draft.dreamingEnabled = false;
    p.note('Dreaming is disabled because memory is currently off.', 'Dreaming');
    return chooseProgressAction({
      message: 'Continue?',
      continueLabel: 'Continue',
      includeBack: true,
    });
  }

  p.note(
    'Dreaming runs background memory cleanup and improvement. Default is enabled.',
    'Dreaming',
  );

  const value = await p.select({
    message: 'Dreaming setting',
    options: [
      {
        value: 'on',
        label: 'Keep dreaming on (Recommended)',
      },
      {
        value: 'off',
        label: 'Turn dreaming off',
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
      storageProvider: draft.storageProvider,
      primaryProvider: draft.primaryProvider,
      claudeOauthToken: draft.claudeOauthToken || undefined,
      anthropicApiKey: draft.anthropicApiKey || undefined,
      anthropicModel: draft.selectedModel || undefined,
      telegramBotToken: draft.telegramBotToken,
      slackBotToken: draft.slackBotToken,
      slackAppToken: draft.slackAppToken,
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
  spinner.start('Creating channel group runtime data...');
  try {
    if (draft.primaryProvider === 'slack') {
      const result = await registerSlackMainGroup({
        runtimeHome: draft.runtimeHome,
        chatJid: draft.slackChatJid,
        displayName: draft.slackDisplayName,
      });
      spinner.stop(`Registered ${result.groupName} (${result.folder})`);
    } else {
      const result = await registerTelegramMainGroup({
        runtimeHome: draft.runtimeHome,
        chatJid: draft.telegramChatJid,
        displayName: draft.telegramDisplayName,
      });
      spinner.stop(`Registered ${result.groupName} (${result.folder})`);
    }
  } catch (err) {
    spinner.stop('Group registration failed');
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      `Could not register ${draft.primaryProvider} group. Next action: verify chat access and token(s), then retry.\n${message}`,
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
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
  const hasProcessableGroup = hasProcessableGroupForConfiguredChannel(
    draft.runtimeHome,
  );

  p.note(formatDoctorReport(report), 'Verification');

  if (!runtimeConfigured) {
    p.log.warn(
      'Setup is not complete yet. Next action: connect a channel now.',
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
    };
  }
  if (!hasProcessableGroup) {
    const connectCommands = listChannelProviders().map(
      (provider) => `\`myclaw ${provider.id} connect\``,
    );
    p.log.warn(
      `Setup is not complete yet. Next action: ensure one enabled channel has credentials and a registered group (${connectCommands.join(' or ')}).`,
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
    };
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
      action = await runCredentialsStep(draft);
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
      return { status: 'cancelled', runtimeHome, startAfterSetup: false };
    }

    if (action.type === 'resume') {
      state.currentStep = step;
      state.status = 'in_progress';
      updateStateData(state, draft);
      persistProgress(state, runtimeHome);
      p.outro('Setup paused. Run `myclaw` or `myclaw setup` to resume.');
      return { status: 'resumed', runtimeHome, startAfterSetup: false };
    }

    if (action.type === 'goto') {
      const target = FULL_SEQUENCE.indexOf(action.step);
      index = target >= 0 ? target : index;
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
      continue;
    }

    index += 1;
  }

  state.status = 'completed';
  state.currentStep = 'ready';
  updateStateData(state, draft);
  persistProgress(state, runtimeHome);
  p.outro('MyClaw is ready.');
  return {
    status: 'completed',
    runtimeHome,
    startAfterSetup: draft.startAfterSetup,
  };
}
