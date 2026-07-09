import * as p from '@clack/prompts';

import { listConnectableChannelProviders } from '../channels/provider-registry.js';
import { ensureRuntimeWritable } from '../config/settings/runtime-home.js';
import { agentEngineLabel } from '../shared/agent-engine.js';
import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import { resolveModelSelectionForWorkload } from '../shared/model-catalog.js';
import {
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  noteRestartRequired,
  writeDesiredRuntimeSettings,
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
import {
  requiredModelCredentialProviderReasonsForSetupDraft,
  requiredModelCredentialProvidersForSetupDraft,
  verifyModelAccess,
} from './setup-credentials.js';

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
      `Model provider: ${resolvedModelProvider(draft.selectedModel)}`,
      `Main model: ${draft.selectedModel}`,
      `Agent harness: ${draft.agentHarness} (${resolvedHarnessLabel(draft.selectedModel)})`,
      `Required model providers: ${formatProviderIds(requiredModelCredentialProvidersForSetupDraft(draft))}`,
      ...formatRequiredProviderReasons(draft),
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
    await persistOnboardingConfig({
      runtimeHome: draft.runtimeHome,
      postgresDatabaseUrl: draft.postgresDatabaseUrl || undefined,
      postgresSchema: draft.postgresSchema || undefined,
      primaryProvider: draft.primaryProvider,
      modelAlias: draft.selectedModel || undefined,
      telegramBotToken: draft.telegramBotToken,
      hasStoredTelegramSecretRefs: draft.hasStoredTelegramSecretRefs,
      telegramPermissionApproverIds: draft.telegramPermissionApproverIds,
      slackBotToken: draft.slackBotToken,
      slackAppToken: draft.slackAppToken,
      hasStoredSlackSecretRefs: draft.hasStoredSlackSecretRefs,
      slackPermissionApproverIds: draft.slackPermissionApproverIds,
      credentialMode: draft.credentialMode,
      agentName: draft.agentName,
      agentHarness: draft.agentHarness,
      memoryEnabled: draft.memoryEnabled,
      embeddingsEnabled: draft.embeddingsEnabled,
      dreamingEnabled: draft.dreamingEnabled,
    });
    spinner.stop('Runtime config written');
  } catch (err) {
    spinner.stop('Failed to write config');
    const message = err instanceof Error ? err.message : String(err);
    const nextAction = message.includes(
      'Settings mutation is based on stale settings',
    )
      ? 'another process changed settings during setup — re-run `gantry setup`; your answers are saved and pre-filled'
      : 'check Postgres connectivity (`gantry doctor`), then re-run `gantry setup`';
    p.log.error(setupBlocked(`could not save config (${message})`, nextAction));
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
      const approverIds = parseApproverIds(draft.slackPermissionApproverIds);
      const result = await registerSlackMainGroup({
        runtimeHome: draft.runtimeHome,
        chatJid: draft.slackChatJid,
        displayName: draft.agentName,
        conversationDisplayName: conversationLabel,
        approverIds,
      });
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
      const previousSettings = structuredClone(settings);
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
      const writeResult = await writeDesiredRuntimeSettings({
        runtimeHome: draft.runtimeHome,
        settings,
        previousSettings,
        createdBy: 'cli:onboarding',
      });
      noteRestartRequired(writeResult);
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
  const credentialLiveSkipProviderIds =
    draft.credentialLiveSkipProviderIds ?? [];
  const report = await runDoctorWithNetwork(importMetaUrl, draft.runtimeHome, {
    modelCredentialLiveSkipProviderIds: credentialLiveSkipProviderIds,
  });
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
          : 'choose Telegram or Slack in the Chat channel step.',
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
    if (failure?.id === 'model-access-credentials') {
      return { type: 'goto', step: 'credentials' };
    }
    return { type: 'resume' };
  }

  const modelAccess = await verifyModelAccess(
    draft.runtimeHome,
    loadRuntimeSettings(draft.runtimeHome),
    { skipLiveProviderIds: credentialLiveSkipProviderIds },
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

function formatProviderIds(providerIds: readonly string[]): string {
  return providerIds.length > 0 ? providerIds.join(', ') : 'none';
}

function formatRequiredProviderReasons(draft: SetupDraft): string[] {
  return requiredModelCredentialProviderReasonsForSetupDraft(draft).map(
    ({ providerId, reasons }) =>
      `  ${providerId}: ${reasons.length ? reasons.join('; ') : 'selected defaults'}`,
  );
}

function resolvedHarnessLabel(alias: string): string {
  const resolved = resolveModelSelectionForWorkload(alias, 'chat');
  if (!resolved.ok) return 'unknown';
  const route = resolveExecutionRoute({ entry: resolved.entry });
  return route.ok ? agentEngineLabel(route.value.engine) : 'unknown';
}

function resolvedModelProvider(alias: string): string {
  const resolved = resolveModelSelectionForWorkload(alias, 'chat');
  return resolved.ok ? resolved.entry.modelRoute.id : 'unknown';
}
