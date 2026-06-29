import * as p from '@clack/prompts';

import { requiredModelCredentialProviders } from '../application/model-resolution/required-model-credential-providers.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import {
  DEFAULT_MODEL_PRESET_ID,
  getModelPreset,
  resolveModelSelectionForWorkload,
  type ModelPresetId,
  type ModelWorkload,
} from '../shared/model-catalog.js';
import { getModelProviderDefinition } from '../shared/model-provider-registry.js';
import {
  listReadyModelCredentialProviders,
  promptModelCredentialPayload,
  storeModelCredentialInput,
} from './credentials.js';
import { inspectModelCredentialReadiness } from './model-credential-readiness.js';
import { prepareOnboardingCredentialStorage } from './onboarding-config.js';

export interface CredentialSetupDraft {
  credentialMode: HostCredentialMode;
  postgresSetupKind?: 'local' | 'hosted' | 'existing';
  postgresDatabaseUrl?: string;
  postgresSchema?: string;
  modelPreset?: ModelPresetId;
  selectedModel?: string;
  memoryEnabled?: boolean;
  embeddingsEnabled?: boolean;
  dreamingEnabled?: boolean;
}

export type CredentialStepAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: 'storage' }
  | { type: 'resume' }
  | { type: 'cancel' };

export async function verifyModelAccess(
  runtimeHome?: string,
  settings?: Parameters<typeof inspectModelCredentialReadiness>[1],
): Promise<{ ok: boolean; message: string; nextAction?: string }> {
  if (!runtimeHome || !settings) {
    return {
      ok: false,
      message: 'runtime settings are required for Model Access verification.',
      nextAction: 'run `gantry setup` from the configured Runtime home.',
    };
  }

  try {
    const check = await inspectModelCredentialReadiness(runtimeHome, settings);
    return {
      ok: check.status !== 'fail',
      message: check.message,
      nextAction: check.nextAction,
    };
  } catch (err) {
    return {
      ok: false,
      message: `could not inspect Model Access (${err instanceof Error ? err.message : String(err)})`,
      nextAction: 'run `gantry credentials model doctor`.',
    };
  }
}

export async function runCredentialsStep(
  draft: CredentialSetupDraft,
  runtimeHome: string,
): Promise<CredentialStepAction> {
  draft.credentialMode = 'gantry';
  try {
    await prepareOnboardingCredentialStorage({
      runtimeHome,
      postgresDatabaseUrl: draft.postgresDatabaseUrl,
      postgresSchema: draft.postgresSchema,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(
      [
        `Setup blocked: could not prepare Model Access storage (${message})`,
        'Next action: return to the Database step and provide a reachable Postgres URL.',
      ].join('\n'),
    );
    return { type: 'goto', step: 'storage' };
  }
  const requiredProviders =
    requiredModelCredentialProvidersForSetupDraft(draft);
  p.note(
    `Selected defaults require credentials for: ${formatProviderIds(requiredProviders)}.`,
    'Model Access required',
  );

  const readyProviders =
    await tryListReadyModelCredentialProviders(runtimeHome);
  const missingProviders = requiredProviders.filter(
    (providerId) => !readyProviders.has(providerId),
  );
  if (missingProviders.length === 0) {
    p.log.success('Required Model Access credentials are already configured.');
    return { type: 'next' };
  }

  for (const providerId of missingProviders) {
    const provider = getModelProviderDefinition(providerId);
    if (!provider) {
      p.log.error(`Unsupported required model provider: ${providerId}.`);
      return { type: 'cancel' };
    }
    const selectedMode =
      provider.credentialModes.length === 1
        ? provider.credentialModes[0]!.id
        : await p.select({
            message: 'Credential auth mode',
            options: [
              ...provider.credentialModes.map((mode) => ({
                value: mode.id,
                label: mode.label,
                hint: mode.helpText,
              })),
              { value: 'back', label: 'Back' },
              { value: 'resume', label: 'Resume Later' },
              { value: 'cancel', label: 'Cancel Setup' },
            ],
          });
    if (p.isCancel(selectedMode)) return { type: 'cancel' };
    if (
      selectedMode === 'back' ||
      selectedMode === 'resume' ||
      selectedMode === 'cancel'
    ) {
      return { type: selectedMode };
    }
    const selectedModeId = String(selectedMode);
    p.note(
      [
        'Gantry stores the real provider credential encrypted in Credential Center.',
        'Agent runners receive only a loopback gateway URL and a short-lived gtw_* token.',
        'The trusted host injects the real provider auth only when forwarding approved model API calls.',
      ].join('\n'),
      'Model Access',
    );
    const captureChoice = await p.select({
      message: 'Store this model credential now?',
      options: [
        {
          value: 'store',
          label: `Store ${provider.label}`,
          hint: 'Required before Gantry can be ready.',
        },
        { value: 'back', label: 'Back' },
        { value: 'resume', label: 'Resume Later' },
        { value: 'cancel', label: 'Cancel Setup' },
      ],
    });
    if (p.isCancel(captureChoice)) return { type: 'cancel' };
    if (
      captureChoice === 'back' ||
      captureChoice === 'resume' ||
      captureChoice === 'cancel'
    ) {
      return { type: captureChoice };
    }
    const credentialInput = await promptModelCredentialPayload(provider.id, {
      authMode: selectedModeId,
    });
    if (!credentialInput) return { type: 'cancel' };
    await storeModelCredentialInput({
      runtimeHome,
      providerId: provider.id,
      authMode: credentialInput.authMode,
      payload: credentialInput.payload,
    });
    p.log.success(
      `${provider.label} credential stored. Model Access is ready to validate during runtime preflight.`,
    );
  }
  return { type: 'next' };
}

export function requiredModelCredentialProvidersForSetupDraft(
  draft: CredentialSetupDraft,
): string[] {
  const preset = getModelPreset(draft.modelPreset ?? DEFAULT_MODEL_PRESET_ID);
  const chatModel = draft.selectedModel || preset.chatDefault;
  const memoryEnabled = draft.memoryEnabled ?? true;
  const embeddingsEnabled = memoryEnabled && (draft.embeddingsEnabled ?? false);
  return requiredModelCredentialProviders({
    agent: {
      defaultModel: chatModel,
      oneTimeJobDefaultModel: preset.oneTimeJobDefault,
      recurringJobDefaultModel: preset.recurringJobDefault,
    },
    memory: {
      enabled: memoryEnabled,
      embeddings: {
        enabled: embeddingsEnabled,
        provider: embeddingsEnabled ? 'openai' : 'disabled',
      },
      dreaming: {
        enabled: memoryEnabled && (draft.dreamingEnabled ?? true),
        embeddings: {
          enabled: false,
          provider: 'disabled',
        },
      },
      llm: {
        models: preset.memoryDefaults,
      },
    },
  });
}

export interface RequiredModelCredentialProviderReason {
  providerId: string;
  reasons: string[];
}

export function requiredModelCredentialProviderReasonsForSetupDraft(
  draft: CredentialSetupDraft,
): RequiredModelCredentialProviderReason[] {
  const preset = getModelPreset(draft.modelPreset ?? DEFAULT_MODEL_PRESET_ID);
  const chatModel = draft.selectedModel || preset.chatDefault;
  const memoryEnabled = draft.memoryEnabled ?? true;
  const embeddingsEnabled = memoryEnabled && (draft.embeddingsEnabled ?? false);
  const reasons = new Map<string, Set<string>>();
  const addReason = (providerId: string, reason: string) => {
    const set = reasons.get(providerId) ?? new Set<string>();
    set.add(reason);
    reasons.set(providerId, set);
  };
  const addModelReason = (
    alias: string,
    workload: ModelWorkload,
    reason: string,
  ) => {
    const resolved = resolveModelSelectionForWorkload(alias, workload);
    if (resolved.ok) addReason(resolved.entry.modelRoute.id, reason);
  };

  addModelReason(chatModel, 'chat', `main model ${chatModel}`);
  addModelReason(
    preset.oneTimeJobDefault || chatModel,
    'one_time_job',
    preset.oneTimeJobDefault
      ? `one-time job model ${preset.oneTimeJobDefault}`
      : 'one-time jobs inherit main model',
  );
  addModelReason(
    preset.recurringJobDefault || chatModel,
    'recurring_job',
    preset.recurringJobDefault
      ? `recurring job model ${preset.recurringJobDefault}`
      : 'recurring jobs inherit main model',
  );
  if (memoryEnabled) {
    addModelReason(
      preset.memoryDefaults.extractor,
      'memory_extractor',
      `memory LLM extractor ${preset.memoryDefaults.extractor}`,
    );
    addModelReason(
      preset.memoryDefaults.dreaming,
      'memory_dreaming',
      `memory LLM dreaming ${preset.memoryDefaults.dreaming}`,
    );
    addModelReason(
      preset.memoryDefaults.consolidation,
      'memory_consolidation',
      `memory LLM consolidation ${preset.memoryDefaults.consolidation}`,
    );
    if (embeddingsEnabled) {
      addReason('openai', 'memory embeddings');
    }
  }

  return requiredModelCredentialProvidersForSetupDraft(draft).map(
    (providerId) => ({
      providerId,
      reasons: [...(reasons.get(providerId) ?? [])].sort(),
    }),
  );
}

function formatProviderIds(providerIds: readonly string[]): string {
  return providerIds.length > 0 ? providerIds.join(', ') : 'none';
}

async function tryListReadyModelCredentialProviders(
  runtimeHome: string,
): Promise<Set<string>> {
  try {
    return await listReadyModelCredentialProviders(runtimeHome);
  } catch {
    return new Set();
  }
}
