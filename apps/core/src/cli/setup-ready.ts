import * as p from '@clack/prompts';

import type { HostCredentialMode } from '../config/credentials/mode.js';
import { getServiceStatus } from '../infrastructure/service/manager.js';

export interface SetupReadyDraft {
  runtimeHome: string;
  primaryProvider: 'telegram' | 'slack';
  telegramChatJid: string;
  slackChatJid: string;
  selectedModel: string;
  credentialMode: HostCredentialMode;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
  serviceStartedAfterSetup?: boolean;
}

export type ReadyStepAction = { type: 'next' } | { type: 'start_now' };

function summarizeToggle(value: boolean): string {
  return value ? 'on' : 'off';
}

export async function runReadyStep(
  draft: SetupReadyDraft,
): Promise<ReadyStepAction> {
  const service = getServiceStatus(draft.runtimeHome);
  const providerLabel =
    draft.primaryProvider === 'slack' ? 'Slack conversation' : 'Telegram chat';
  const providerChatJid =
    draft.primaryProvider === 'slack'
      ? draft.slackChatJid || '(pending)'
      : draft.telegramChatJid || '(pending)';
  p.note(
    [
      `Runtime home: ${draft.runtimeHome}`,
      `Primary provider: ${draft.primaryProvider}`,
      `${providerLabel}: ${providerChatJid}`,
      `Main model: ${draft.selectedModel}`,
      `Model access: ${draft.credentialMode === 'gantry' ? 'enabled' : 'disabled'}`,
      `Memory: ${summarizeToggle(draft.memoryEnabled)}`,
      `Embeddings: ${draft.embeddingsEnabled ? 'brokered provider' : 'disabled'}`,
      `Dreaming: ${summarizeToggle(draft.dreamingEnabled)}`,
      `Service (${service.kind}): ${service.status}`,
    ].join('\n'),
    'Ready',
  );

  const options = [
    {
      value: 'next',
      label: 'Finish setup and exit (Recommended)',
      hint: draft.serviceStartedAfterSetup
        ? 'Background service is already running.'
        : 'Return to the terminal. Start later with `gantry start`.',
    },
    ...(draft.serviceStartedAfterSetup
      ? []
      : [
          {
            value: 'start_now',
            label: 'Start Gantry now',
            hint: `Begin listening on ${draft.primaryProvider} immediately.`,
          },
        ]),
  ];

  const value = await p.select({
    message: 'Setup complete. What should Gantry do now?',
    options,
  });

  if (p.isCancel(value)) return { type: 'next' };
  if (value === 'start_now' && !draft.serviceStartedAfterSetup) {
    return { type: 'start_now' };
  }
  return { type: 'next' };
}
