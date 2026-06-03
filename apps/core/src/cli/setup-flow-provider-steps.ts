import * as p from '@clack/prompts';

import {
  normalizeSlackChatJid,
  validateSlackAppToken,
  validateSlackBotToken,
  verifySlackChatAccess,
} from './slack.js';
import { listSlackRecentChats } from './slack-chat-discovery.js';
import {
  normalizeTelegramChatJid,
  validateTelegramBotToken,
  verifyTelegramChatAccess,
} from './telegram.js';
import { DEFAULT_AGENT_CLI_NAME } from './main-agent.js';
import { listTelegramRecentChats } from './telegram-chat-discovery.js';
import {
  type FlowAction,
  isInputFlowControl,
  parseInputFlowControl,
} from './setup-flow-control.js';
import { chooseProgressAction } from './setup-flow-prompts.js';
import {
  normalizeSlackPermissionApproverIds,
  validateSlackPermissionApproverIdsInput,
} from './setup-slack-approvers.js';
import type { SetupDraft } from './setup-flow-state.js';

function setupBlocked(reason: string, nextAction: string): string {
  return [`Setup blocked: ${reason}`, `Next action: ${nextAction}`].join('\n');
}

async function promptTelegramAdminSenderIdForManualChat(
  draft: SetupDraft,
): Promise<FlowAction> {
  const adminInput = await p.text({
    message:
      'Telegram sender/user ID for session admin (optional, /back, /resume, /cancel)',
    placeholder:
      'Press Enter to skip; enter only your own trusted Telegram user ID',
    defaultValue: draft.telegramAdminSenderId,
    validate: (value) => {
      const trimmed = String(value ?? '').trim();
      if (isInputFlowControl(trimmed)) return undefined;
      if (!trimmed) return undefined;
      return /^-?\d+$/.test(trimmed)
        ? undefined
        : 'Use a numeric Telegram user ID.';
    },
  });
  if (p.isCancel(adminInput)) return { type: 'resume' };
  const control = parseInputFlowControl(adminInput);
  if (control) return control;
  draft.telegramAdminSenderId = String(adminInput ?? '').trim();
  draft.telegramAdminSenderName = draft.telegramAdminSenderId;
  return { type: 'next' };
}

function normalizeTelegramPermissionApproverIds(raw: string): string {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => /^-?\d+$/.test(entry))
    .join(',');
}

function validateTelegramPermissionApproverIdsInput(
  value: string | undefined,
): string | undefined {
  const trimmed = String(value ?? '').trim();
  if (isInputFlowControl(trimmed)) return undefined;
  if (!trimmed) return 'At least one Telegram approver user ID is required.';
  const parsed = normalizeTelegramPermissionApproverIds(trimmed);
  if (!parsed) {
    return 'Use numeric Telegram user IDs separated by commas (for example: 12345,67890).';
  }
  return undefined;
}

async function promptTelegramPermissionApproverIds(
  draft: SetupDraft,
): Promise<FlowAction> {
  const defaultValue =
    draft.telegramPermissionApproverIds || draft.telegramAdminSenderId;
  const input = await p.text({
    message:
      'Telegram approver user IDs; seeds conversation approvers (/back, /resume, /cancel)',
    placeholder: '12345,67890',
    defaultValue,
    validate: validateTelegramPermissionApproverIdsInput,
  });
  if (p.isCancel(input)) return { type: 'resume' };
  const control = parseInputFlowControl(input);
  if (control) return control;
  draft.telegramPermissionApproverIds = normalizeTelegramPermissionApproverIds(
    String(input),
  );
  return { type: 'next' };
}

export async function runTelegramStep(draft: SetupDraft): Promise<FlowAction> {
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
        setupBlocked(
          validation.message,
          validation.nextAction || 'choose Try token again.',
        ),
        'Blocked',
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
    draft.telegramAdminSenderId = '';
    draft.telegramAdminSenderName = '';
    draft.telegramPermissionApproverIds = '';

    let normalizedJid = '';
    let selectedConversationLabel = '';
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
        message: 'Choose the Telegram chat for Gantry',
        options: [
          ...discovered.chats.slice(0, 15).map((chat) => ({
            value: chat.chatJid,
            label: `${chat.chatTitle} (${chat.chatJid.replace(/^tg:/, '')})`,
            hint: chat.chatType,
          })),
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
      normalizedJid = normalizeTelegramChatJid(String(selected)) || '';
      const selectedChat = discovered.chats.find(
        (chat) => chat.chatJid === normalizedJid,
      );
      selectedConversationLabel = selectedChat?.chatTitle || '';
      if (selectedChat?.chatType === 'private') {
        draft.telegramAdminSenderId =
          /^tg:(\d+)$/.exec(selectedChat.chatJid)?.[1] || '';
        draft.telegramAdminSenderName =
          selectedChat.lastSenderName || draft.telegramAdminSenderId;
      } else {
        draft.telegramAdminSenderId = '';
        draft.telegramAdminSenderName = '';
      }
      if (!draft.telegramAdminSenderId) {
        const adminAction =
          await promptTelegramAdminSenderIdForManualChat(draft);
        if (adminAction.type !== 'next') return adminAction;
      }
      const approverAction = await promptTelegramPermissionApproverIds(draft);
      if (approverAction.type !== 'next') return approverAction;
    } else {
      discoverySpinner.stop('No recent Telegram chat found.');
      if (discovered.nextAction) p.log.info(discovered.nextAction);
      const retryChoice = await p.select({
        message: 'No Telegram chats are available for discovery yet.',
        options: [
          {
            value: 'retry',
            label: 'Retry discovery (Recommended)',
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
      if (p.isCancel(retryChoice)) return { type: 'resume' };
      if (retryChoice === 'retry') {
        continue;
      }
      if (retryChoice === 'back') return { type: 'back' };
      if (retryChoice === 'resume') return { type: 'resume' };
      return { type: 'cancel' };
    }

    if (!normalizedJid) {
      p.log.error(
        setupBlocked(
          'invalid Telegram chat ID format',
          'choose Try again with a numeric Telegram chat ID.',
        ),
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
      sendTestMessage: false,
    });
    if (!chatAccess.ok) {
      chatCheckSpinner.stop('Chat access check failed');
      p.note(
        setupBlocked(
          chatAccess.message,
          chatAccess.nextAction ||
            'choose Try again after fixing chat permissions.',
        ),
        'Blocked',
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
    draft.telegramDisplayName =
      chatAccess.chatTitle ||
      selectedConversationLabel ||
      draft.telegramChatJid;

    p.note(
      [
        `Agent: ${draft.agentName || DEFAULT_AGENT_CLI_NAME}`,
        `Bot: ${draft.telegramBotUsername ? `@${draft.telegramBotUsername}` : 'Configured'}`,
        `Chat: ${draft.telegramDisplayName} (${draft.telegramChatJid})`,
        `Session admin: ${
          draft.telegramAdminSenderId
            ? draft.telegramAdminSenderName || draft.telegramAdminSenderId
            : 'not detected yet'
        }`,
        `Permission approvers: ${draft.telegramPermissionApproverIds}`,
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

export async function runSlackStep(draft: SetupDraft): Promise<FlowAction> {
  if (draft.primaryProvider !== 'slack') {
    return { type: 'next' };
  }
  p.note(
    [
      '1. Create a Slack app from app settings for the target workspace.',
      '2. Add a bot user and bot scopes for posting, conversation discovery, and message events.',
      '   Minimum practical scopes: chat:write, app_mentions:read, channels:read, groups:read, im:read, mpim:read, plus message history scopes for the conversation types you want Gantry to read.',
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
        setupBlocked(
          botValidation.message,
          botValidation.nextAction || 'choose Try token again.',
        ),
        'Blocked',
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
        setupBlocked(
          appValidation.message,
          appValidation.nextAction || 'choose Try app token again.',
        ),
        'Blocked',
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
    let selectedConversationLabel = '';
    const discoverySpinner = p.spinner();
    discoverySpinner.start('Looking for accessible Slack conversations...');
    const discovered = await listSlackRecentChats({ botToken, limit: 100 });
    if (discovered.ok && discovered.chats.length > 0) {
      discoverySpinner.stop(`Found ${discovered.chats.length} conversations.`);
      const selected = await p.select({
        message: 'Choose the Slack conversation for Gantry',
        options: [
          ...discovered.chats.slice(0, 20).map((chat) => ({
            value: chat.chatJid,
            label: `${chat.chatTitle} (${chat.chatJid.replace(/^sl:/, '')})`,
            hint: chat.chatType,
          })),
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
      normalizedJid = normalizeSlackChatJid(String(selected)) || '';
      selectedConversationLabel =
        discovered.chats.find((chat) => chat.chatJid === normalizedJid)
          ?.chatTitle || '';
    } else {
      discoverySpinner.stop('No accessible Slack conversation found.');
      if (discovered.nextAction) p.log.info(discovered.nextAction);
      const retryChoice = await p.select({
        message: 'No Slack conversations are available for discovery yet.',
        options: [
          {
            value: 'retry',
            label: 'Retry discovery (Recommended)',
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
      if (p.isCancel(retryChoice)) return { type: 'resume' };
      if (retryChoice === 'retry') {
        continue;
      }
      if (retryChoice === 'back') return { type: 'back' };
      if (retryChoice === 'resume') return { type: 'resume' };
      return { type: 'cancel' };
    }

    if (!normalizedJid) {
      p.log.error(
        setupBlocked(
          'invalid Slack conversation ID format',
          'choose Try again with a valid Slack conversation ID.',
        ),
      );
      continue;
    }
    draft.slackChatJid = normalizedJid;

    const access = await verifySlackChatAccess({
      botToken,
      chatJid: draft.slackChatJid,
      sendTestMessage: false,
    });
    if (!access.ok) {
      p.note(
        setupBlocked(
          access.message,
          access.nextAction ||
            'choose Try again after fixing conversation access.',
        ),
        'Blocked',
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
    draft.slackDisplayName =
      access.chatTitle || selectedConversationLabel || draft.slackChatJid;

    const approverInput = await p.text({
      message:
        'Slack admin/approver user IDs; seeds this conversation approvers (/back, /resume, /cancel)',
      placeholder: 'U0123456789,U0987654321',
      defaultValue: draft.slackPermissionApproverIds,
      validate: validateSlackPermissionApproverIdsInput,
    });
    if (p.isCancel(approverInput)) return { type: 'resume' };
    const approverControl = parseInputFlowControl(approverInput);
    if (approverControl) return approverControl;
    draft.slackPermissionApproverIds = normalizeSlackPermissionApproverIds(
      String(approverInput),
    );

    p.note(
      [
        `Agent: ${draft.agentName || DEFAULT_AGENT_CLI_NAME}`,
        `Conversation: ${draft.slackDisplayName} (${draft.slackChatJid})`,
        `Permission approvers: ${draft.slackPermissionApproverIds}`,
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
