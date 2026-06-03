import * as p from '@clack/prompts';

import { listConnectableChannelProviders } from '../channels/provider-registry.js';
import { ensureRuntimeWritable } from '../config/settings/runtime-home.js';
import {
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  formatDoctorReport,
  hasProcessableGroupForConfiguredChannel,
  hasRuntimeConfig,
  runDoctorWithNetwork,
} from './doctor.js';
import { persistOnboardingConfig } from './onboarding-config.js';
import { registerSlackMainGroup } from './slack.js';
import { registerTelegramMainGroup } from './telegram.js';
import { type FlowAction } from './setup-flow-control.js';
import { chooseProgressAction } from './setup-flow-prompts.js';
import type { SetupDraft } from './setup-flow-state.js';
import { verifyModelAccess } from './setup-credentials.js';

function setupBlocked(reason: string, nextAction: string): string {
  return [`Setup blocked: ${reason}`, `Next action: ${nextAction}`].join('\n');
}

function parseApproverIds(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

export async function runConfigStep(draft: SetupDraft): Promise<FlowAction> {
  const channelLabel =
    draft.primaryProvider === 'slack'
      ? `Slack ${draft.slackChatJid}`
      : `Telegram ${draft.telegramChatJid}`;
  p.note(
    [
      `Runtime home: ${draft.runtimeHome}`,
      `Postgres schema: ${draft.postgresSchema}`,
      `Channel: ${channelLabel}`,
      `Model access: ${draft.credentialMode === 'gantry' ? 'enabled' : 'disabled'}`,
      `Model preset: ${draft.modelPreset}`,
      `Main model: ${draft.selectedModel}`,
      ...(draft.primaryProvider === 'slack'
        ? [`Slack approvers: ${draft.slackPermissionApproverIds}`]
        : [`Telegram approvers: ${draft.telegramPermissionApproverIds}`]),
    ].join('\n'),
    'Review setup',
  );
  const action = await chooseProgressAction({
    message:
      'Create this Gantry runtime now? After this point setup writes config and cannot be cancelled transactionally.',
    continueLabel: 'Create Runtime',
    includeBack: true,
  });
  if (action.type !== 'next') {
    return action;
  }

  const spinner = p.spinner();
  spinner.start('Writing runtime config...');
  try {
    ensureRuntimeWritable(draft.runtimeHome);
    if (!draft.postgresDatabaseUrl) {
      spinner.stop('Database configuration is incomplete');
      p.log.error(
        setupBlocked(
          'missing GANTRY_DATABASE_URL',
          'return to the Database step and provide the Postgres URL.',
        ),
      );
      return { type: 'goto', step: 'storage' };
    }
    persistOnboardingConfig({
      runtimeHome: draft.runtimeHome,
      postgresDatabaseUrl: draft.postgresDatabaseUrl || undefined,
      postgresSchema: draft.postgresSchema || undefined,
      primaryProvider: draft.primaryProvider,
      modelPreset: draft.modelPreset,
      modelAlias: draft.selectedModel || undefined,
      telegramBotToken: draft.telegramBotToken,
      telegramPermissionApproverIds: draft.telegramPermissionApproverIds,
      slackBotToken: draft.slackBotToken,
      slackAppToken: draft.slackAppToken,
      slackPermissionApproverIds: draft.slackPermissionApproverIds,
      credentialMode: draft.credentialMode,
      agentName: draft.agentName,
      memoryEnabled: draft.memoryEnabled,
      embeddingsEnabled: draft.embeddingsEnabled,
      dreamingEnabled: draft.dreamingEnabled,
    });
    spinner.stop('Runtime config written');
  } catch (err) {
    spinner.stop('Failed to write config');
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      setupBlocked(
        `could not save config (${message})`,
        'run `gantry setup` after fixing the save error.',
      ),
    );
    return { type: 'resume' };
  }

  return { type: 'next' };
}

export async function runGroupStep(draft: SetupDraft): Promise<FlowAction> {
  const spinner = p.spinner();
  spinner.start('Creating Conversation runtime data...');
  try {
    if (draft.primaryProvider === 'slack') {
      const conversationLabel = draft.slackDisplayName || draft.slackChatJid;
      const result = await registerSlackMainGroup({
        runtimeHome: draft.runtimeHome,
        chatJid: draft.slackChatJid,
        displayName: draft.agentName,
      });
      const settings = loadRuntimeSettings(draft.runtimeHome);
      ensureConfiguredConversationBinding(settings, {
        agentId: result.folder,
        agentName: result.groupName,
        agentFolder: result.folder,
        jid: draft.slackChatJid,
        displayName: conversationLabel,
        trigger: `@${result.groupName}`,
        requiresTrigger: false,
        approverIds: parseApproverIds(draft.slackPermissionApproverIds),
      });
      saveRuntimeSettings(draft.runtimeHome, settings);
      draft.workspaceKey = result.folder;
      draft.conversationLabel = conversationLabel;
      spinner.stop(`Registered ${result.groupName} (${result.folder})`);
    } else {
      const conversationLabel =
        draft.telegramDisplayName || draft.telegramChatJid;
      const result = await registerTelegramMainGroup({
        runtimeHome: draft.runtimeHome,
        chatJid: draft.telegramChatJid,
        displayName: draft.agentName,
      });
      const approverIds = parseApproverIds(
        draft.telegramPermissionApproverIds || draft.telegramAdminSenderId,
      );
      const settings = loadRuntimeSettings(draft.runtimeHome);
      ensureConfiguredConversationBinding(settings, {
        agentId: result.folder,
        agentName: result.groupName,
        agentFolder: result.folder,
        jid: draft.telegramChatJid,
        displayName: conversationLabel,
        trigger: `@${result.groupName}`,
        requiresTrigger: false,
        approverIds,
      });
      saveRuntimeSettings(draft.runtimeHome, settings);
      draft.workspaceKey = result.folder;
      draft.conversationLabel = conversationLabel;
      spinner.stop(`Registered ${result.groupName} (${result.folder})`);
    }
  } catch (err) {
    spinner.stop('Group registration failed');
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      setupBlocked(
        `could not register ${draft.primaryProvider} conversation (${message})`,
        `return to the ${draft.primaryProvider === 'slack' ? 'Slack' : 'Telegram'} step and choose Try again.`,
      ),
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
    };
  }

  return { type: 'next' };
}

export async function runVerifyStep(
  importMetaUrl: string,
  draft: SetupDraft,
): Promise<FlowAction> {
  const report = await runDoctorWithNetwork(importMetaUrl, draft.runtimeHome);
  const runtimeConfigured = hasRuntimeConfig(draft.runtimeHome);
  const hasProcessableGroup = await hasProcessableGroupForConfiguredChannel(
    draft.runtimeHome,
  );

  p.note(formatDoctorReport(report), 'Verification');

  if (!runtimeConfigured) {
    const connectCommand =
      draft.primaryProvider === 'slack'
        ? '`gantry provider connect slack`'
        : '`gantry provider connect telegram`';
    p.log.warn(
      setupBlocked(
        'no channel connected',
        `connect a channel with ${connectCommand}.`,
      ),
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
    };
  }
  if (!hasProcessableGroup) {
    const connectCommand =
      draft.primaryProvider === 'slack'
        ? '`gantry provider connect slack`'
        : '`gantry provider connect telegram`';
    const providerAvailable = listConnectableChannelProviders().some(
      (provider) => provider.id === draft.primaryProvider,
    );
    p.log.warn(
      setupBlocked(
        'no processable conversation for the configured channel',
        providerAvailable
          ? `run ${connectCommand}.`
          : 'choose Telegram or Slack in the Provider step.',
      ),
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
    };
  }

  if (!report.ok) {
    const failure = report.checks.find((check) => check.status === 'fail');
    p.log.warn(
      setupBlocked(
        failure?.message || 'verification found blocking issues',
        failure?.nextAction || 'run `gantry doctor`, then run `gantry setup`.',
      ),
    );
    return { type: 'resume' };
  }

  const modelAccess = await verifyModelAccess(
    draft.runtimeHome,
    loadRuntimeSettings(draft.runtimeHome),
  );
  if (!modelAccess.ok) {
    p.log.warn(
      setupBlocked(
        modelAccess.message,
        modelAccess.nextAction ||
          'run `gantry credentials model doctor`, then run `gantry setup`.',
      ),
    );
    return { type: 'goto', step: 'credentials' };
  }

  p.log.success(`${modelAccess.message}\nVerification passed.`);
  return { type: 'next' };
}
