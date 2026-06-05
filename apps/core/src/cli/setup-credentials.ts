import * as p from '@clack/prompts';

import type { HostCredentialMode } from '../config/credentials/mode.js';
import { listModelRouteProviders } from '../shared/model-provider-registry.js';
import {
  promptModelCredentialPayload,
  storeModelCredentialInput,
} from './credentials.js';
import { inspectModelCredentialReadiness } from './model-credential-readiness.js';

export interface CredentialSetupDraft {
  credentialMode: HostCredentialMode;
  postgresSetupKind?: 'local' | 'hosted' | 'existing';
}

export type CredentialStepAction =
  | { type: 'next' }
  | { type: 'back' }
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
  const providers = listModelRouteProviders();
  const selectedProvider = await p.select({
    message: 'Model access provider',
    options: [
      ...providers.map((provider) => ({
        value: provider.id,
        label: provider.label,
        hint: provider.supportedWorkloads.join(', '),
      })),
      { value: 'back', label: 'Back' },
      { value: 'resume', label: 'Resume Later' },
      { value: 'cancel', label: 'Cancel Setup' },
    ],
  });
  if (p.isCancel(selectedProvider)) return { type: 'cancel' };
  if (
    selectedProvider === 'back' ||
    selectedProvider === 'resume' ||
    selectedProvider === 'cancel'
  ) {
    return { type: selectedProvider };
  }
  const provider = providers.find((item) => item.id === selectedProvider);
  if (!provider) return { type: 'cancel' };
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
        label: 'Store now',
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
  if (captureChoice === 'store') {
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
    return { type: 'next' };
  }
  return { type: 'cancel' };
}
