import * as p from '@clack/prompts';

import { getServiceStatus } from './service-manager.js';

export interface SetupReadyDraft {
  runtimeHome: string;
  telegramChatJid: string;
  credentialMode: 'env-only' | 'onecli-only' | 'hybrid';
  onecliUrl: string;
  memoryEnabled: boolean;
  memoryProvider?: 'sqlite' | 'qmd' | 'noop';
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}

function summarizeToggle(value: boolean): string {
  return value ? 'on' : 'off';
}

export async function runReadyStep(
  draft: SetupReadyDraft,
): Promise<{ type: 'next' }> {
  const service = getServiceStatus(draft.runtimeHome);
  p.note(
    [
      `Runtime home: ${draft.runtimeHome}`,
      `Telegram chat: ${draft.telegramChatJid}`,
      `Credential mode: ${draft.credentialMode}`,
      ...(draft.onecliUrl ? [`OneCLI URL: ${draft.onecliUrl}`] : []),
      `Memory: ${summarizeToggle(draft.memoryEnabled)}`,
      `Memory provider: ${draft.memoryEnabled ? draft.memoryProvider || 'sqlite' : 'noop'}`,
      `Embeddings: ${draft.embeddingsEnabled ? 'openai' : 'disabled'}`,
      `Dreaming: ${summarizeToggle(draft.dreamingEnabled)}`,
      `Service (${service.kind}): ${service.status}`,
      '',
      'Next steps:',
      '- Run `myclaw status` to view your dashboard.',
      '- Run `myclaw start` to run MyClaw now.',
    ].join('\n'),
    'Ready',
  );
  return { type: 'next' };
}
