import * as p from '@clack/prompts';

import { agentEngineLabel } from '../shared/agent-engine.js';
import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import {
  resolveModelSelectionForWorkload,
  type ModelPresetId,
} from '../shared/model-catalog.js';
import {
  requiredModelCredentialProviderReasonsForSetupDraft,
  requiredModelCredentialProvidersForSetupDraft,
} from './setup-credentials.js';

export interface SetupReadyDraft {
  workspaceKey: string;
  agentName: string;
  agentHarness: string;
  conversationLabel: string;
  selectedModel: string;
  modelPreset?: ModelPresetId;
  memoryEnabled?: boolean;
  embeddingsEnabled?: boolean;
  dreamingEnabled?: boolean;
}

export type ReadyStepAction = { type: 'next' } | { type: 'start_now' };

export async function runReadyStep(
  draft: SetupReadyDraft,
): Promise<ReadyStepAction> {
  p.note(
    [
      'Gantry is ready.',
      '',
      `Workspace: ${draft.workspaceKey}`,
      `Agent: ${draft.agentName}`,
      `Agent harness: ${draft.agentHarness}`,
      `Conversation: ${draft.conversationLabel}`,
      `Model: ${draft.selectedModel}`,
      `Resolved model/harness: ${draft.selectedModel} / ${resolvedHarnessLabel(draft.selectedModel)}`,
      `Required model providers: ${formatProviderIds(requiredModelProviders(draft))}`,
      ...formatRequiredProviderReasons(draft),
      '',
      'Next: Start chatting or run gantry status.',
      'Optional setup: memory, background service, extra providers.',
    ].join('\n'),
    'Ready',
  );

  const value = await p.select({
    message: 'Setup complete. What should Gantry do now?',
    options: [
      {
        value: 'next',
        label: 'Finish setup and exit (Recommended)',
        hint: 'Return to the terminal. Start later with `gantry start`.',
      },
      {
        value: 'start_now',
        label: 'Start Gantry now',
        hint: 'Run `gantry start` immediately.',
      },
    ],
  });

  if (p.isCancel(value)) return { type: 'next' };
  if (value === 'start_now') return { type: 'start_now' };
  return { type: 'next' };
}

function resolvedHarnessLabel(alias: string): string {
  const resolved = resolveModelSelectionForWorkload(alias, 'chat');
  if (!resolved.ok) return 'unknown';
  const route = resolveExecutionRoute({ entry: resolved.entry });
  return route.ok ? agentEngineLabel(route.value.engine) : 'unknown';
}

function formatProviderIds(providerIds: readonly string[]): string {
  return providerIds.length > 0 ? providerIds.join(', ') : 'none';
}

function requiredModelProviders(draft: SetupReadyDraft): string[] {
  return requiredModelCredentialProvidersForSetupDraft({
    credentialMode: 'gantry',
    modelPreset: draft.modelPreset,
    selectedModel: draft.selectedModel,
    memoryEnabled: draft.memoryEnabled,
    embeddingsEnabled: draft.embeddingsEnabled,
    dreamingEnabled: draft.dreamingEnabled,
  });
}

function formatRequiredProviderReasons(draft: SetupReadyDraft): string[] {
  return requiredModelCredentialProviderReasonsForSetupDraft({
    credentialMode: 'gantry',
    modelPreset: draft.modelPreset,
    selectedModel: draft.selectedModel,
    memoryEnabled: draft.memoryEnabled,
    embeddingsEnabled: draft.embeddingsEnabled,
    dreamingEnabled: draft.dreamingEnabled,
  }).map(
    ({ providerId, reasons }) =>
      `  ${providerId}: ${reasons.length ? reasons.join('; ') : 'selected defaults'}`,
  );
}
