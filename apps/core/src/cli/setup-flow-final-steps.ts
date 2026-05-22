import * as p from '@clack/prompts';

import { listConnectableChannelProviders } from '../channels/provider-registry.js';
import {
  formatRuntimePreflightFailure,
  validateRuntimePreflightWithStorage,
} from '../config/preflight.js';
import { ensureRuntimeWritable } from '../config/settings/runtime-home.js';
import {
  ensureConfiguredConversationBinding,
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import {
  installService,
  startService,
} from '../infrastructure/service/manager.js';
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
import type { ServiceChoice, SetupDraft } from './setup-flow-state.js';
import { verifyModelAccess } from './setup-credentials.js';

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

export async function runMemoryStep(draft: SetupDraft): Promise<FlowAction> {
  p.note(
    [
      'Memory stores durable facts, preferences, decisions, corrections, constraints, and procedures.',
      'Current messages retrieve matching memory; agents can call memory_search when they need more context.',
      'Default is enabled.',
    ].join('\n'),
    'Memory',
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

export async function runEmbeddingsStep(
  draft: SetupDraft,
): Promise<FlowAction> {
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
    'Embeddings improve memory search quality. Default is off; external embedding provider credentials belong in Model Access, not Gantry .env.',
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

  p.note(
    [
      'OpenAI embeddings are not enabled during first-run setup.',
      'Next action: finish setup with embeddings off, then configure brokered embedding provider access in Model Access before enabling embeddings.',
    ].join('\n'),
    'Embeddings',
  );
  draft.embeddingsEnabled = false;
  return { type: 'next' };
}

export async function runDreamingStep(draft: SetupDraft): Promise<FlowAction> {
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
      `Credential mode: ${draft.credentialMode}`,
      `Model provider: ${draft.modelProvider}`,
      `Main model: ${draft.selectedModel}`,
      'Memory models: provider-managed',
      ...(draft.primaryProvider === 'slack'
        ? [`Slack approvers: ${draft.slackPermissionApproverIds}`]
        : [`Telegram approvers: ${draft.telegramPermissionApproverIds}`]),
      `Memory: ${draft.memoryEnabled ? 'on' : 'off'}`,
      `Embeddings: ${draft.embeddingsEnabled ? 'brokered provider' : 'disabled'}`,
      `Dreaming: ${draft.dreamingEnabled ? 'on' : 'off'}`,
      `Service: ${draft.serviceChoice === 'skip' ? 'skip for now' : draft.serviceChoice.replace('_', ' + ')}`,
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
    if (!draft.postgresDatabaseUrl || !draft.onecliPostgresDatabaseUrl) {
      spinner.stop('Database configuration is incomplete');
      p.log.error(
        [
          'Gantry requires both GANTRY_DATABASE_URL and ONECLI_DATABASE_URL before writing runtime config.',
          'Next action: return to the storage step and provide both database URLs.',
        ].join('\n'),
      );
      return { type: 'goto', step: 'storage' };
    }
    persistOnboardingConfig({
      runtimeHome: draft.runtimeHome,
      postgresDatabaseUrl: draft.postgresDatabaseUrl || undefined,
      onecliPostgresDatabaseUrl: draft.onecliPostgresDatabaseUrl || undefined,
      postgresSchema: draft.postgresSchema || undefined,
      onecliPostgresSchema: draft.onecliPostgresSchema || undefined,
      primaryProvider: draft.primaryProvider,
      modelProvider: draft.modelProvider,
      modelAlias: draft.selectedModel || undefined,
      telegramBotToken: draft.telegramBotToken,
      telegramPermissionApproverIds: draft.telegramPermissionApproverIds,
      slackBotToken: draft.slackBotToken,
      slackAppToken: draft.slackAppToken,
      slackPermissionApproverIds: draft.slackPermissionApproverIds,
      credentialMode: draft.credentialMode,
      onecliUrl: draft.onecliUrl || undefined,
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
      `Could not save config. Next action: fix the issue below and retry setup.\n${message}`,
    );
    return { type: 'resume' };
  }

  return { type: 'next' };
}

export async function runGroupStep(draft: SetupDraft): Promise<FlowAction> {
  const spinner = p.spinner();
  spinner.start('Creating channel group runtime data...');
  try {
    if (draft.primaryProvider === 'slack') {
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
        displayName: result.groupName,
        trigger: `@${result.groupName}`,
        requiresTrigger: false,
        approverIds: parseApproverIds(draft.slackPermissionApproverIds),
      });
      saveRuntimeSettings(draft.runtimeHome, settings);
      spinner.stop(`Registered ${result.groupName} (${result.folder})`);
    } else {
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
        displayName: result.groupName,
        trigger: `@${result.groupName}`,
        requiresTrigger: false,
        approverIds,
      });
      saveRuntimeSettings(draft.runtimeHome, settings);
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

  return { type: 'next' };
}

export async function runServiceStep(draft: SetupDraft): Promise<FlowAction> {
  const choice = await p.select({
    message: 'Background service (optional)',
    options: [
      {
        value: 'skip',
        label: 'Skip for now (Recommended)',
        hint: 'You can run Gantry manually with `gantry start`.',
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

  return { type: 'next' };
}

export async function applyServiceChoice(
  importMetaUrl: string,
  draft: SetupDraft,
): Promise<void> {
  if (draft.serviceChoice === 'skip') return;

  const installOutcome = installService(importMetaUrl, draft.runtimeHome);
  if (!installOutcome.ok) {
    p.log.warn(
      `Service install failed. Next action: run \`gantry start\` manually, or use the advanced service command later.\n${installOutcome.message}`,
    );
    return;
  }
  p.log.success(installOutcome.message);
}

export async function applyServiceStartChoice(
  draft: SetupDraft,
): Promise<void> {
  if (draft.serviceChoice !== 'install_start') return;

  const validation = await validateRuntimePreflightWithStorage(
    draft.runtimeHome,
  );
  if (!validation.ok && validation.failure) {
    p.log.warn(
      `Service start skipped after verification. Next action: fix runtime preflight and run \`gantry start\` later.\n${formatRuntimePreflightFailure(validation.failure)}`,
    );
    return;
  }
  const startOutcome = startService(draft.runtimeHome);
  if (!startOutcome.ok) {
    p.log.warn(
      `Service start failed. Next action: run \`gantry start\` later.\n${startOutcome.message}`,
    );
  } else {
    draft.serviceStartedAfterSetup = true;
    p.log.success(startOutcome.message);
  }
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
    p.log.warn(
      'Setup is not complete yet. Next action: connect a channel now.',
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
    };
  }
  if (!hasProcessableGroup) {
    const connectCommands = listConnectableChannelProviders().map(
      (provider) => `\`gantry provider connect ${provider.id}\``,
    );
    p.log.warn(
      `Setup is not complete yet. Next action: ensure one enabled provider has credentials and a registered conversation (${connectCommands.join(' or ')}).`,
    );
    return {
      type: 'goto',
      step: draft.primaryProvider === 'slack' ? 'slack' : 'telegram',
    };
  }

  if (!report.ok) {
    p.log.warn(
      'Verification found blocking issues after runtime creation. Setup is saved but not complete; fix the next actions above, then run `gantry setup` to continue.',
    );
    return { type: 'resume' };
  }

  const modelAccess = await verifyModelAccess(draft.onecliUrl);
  if (!modelAccess.ok) {
    p.log.warn(
      `${modelAccess.message}\nNext action: ${modelAccess.nextAction || 'Open Model Access and rerun setup verification.'}`,
    );
    return { type: 'goto', step: 'credentials' };
  }

  p.log.success(`${modelAccess.message}\nVerification passed.`);
  return { type: 'next' };
}
