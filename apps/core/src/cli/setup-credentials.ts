import * as p from '@clack/prompts';

import type { HostCredentialMode } from '../config/credentials/mode.js';
import { listModelRouteProviders } from '../shared/model-provider-registry.js';
import {
  promptModelCredentialPayload,
  storeModelCredentialInput,
} from './credentials.js';

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
  _url?: string,
): Promise<{ ok: boolean; message: string; nextAction?: string }> {
  return {
    ok: true,
    message:
      'Gantry Model Gateway credentials are stored in Postgres and validated during model preflight.',
  };
}

export async function runCredentialsStep(
  draft: CredentialSetupDraft,
  runtimeHome: string,
): Promise<CredentialStepAction> {
  draft.credentialMode = 'gantry';
  const providers = listModelRouteProviders();
  const selectedProvider = await p.select({
    message: 'Model access provider',
    options: providers.map((provider) => ({
      value: provider.id,
      label: provider.label,
      hint: provider.supportedWorkloads.join(', '),
    })),
  });
  if (p.isCancel(selectedProvider)) return { type: 'cancel' };
  const provider = providers.find((item) => item.id === selectedProvider);
  if (!provider) return { type: 'cancel' };
  const selectedMode =
    provider.credentialModes.length === 1
      ? provider.credentialModes[0]!.id
      : await p.select({
          message: 'Credential auth mode',
          options: provider.credentialModes.map((mode) => ({
            value: mode.id,
            label: mode.label,
            hint: mode.helpText,
          })),
        });
  if (p.isCancel(selectedMode)) return { type: 'cancel' };
  const selectedModeId = String(selectedMode);
  const selectedCredentialMode = provider.credentialModes.find(
    (mode) => mode.id === selectedModeId,
  );
  p.note(
    [
      'Gantry stores the real provider credential encrypted in Credential Center.',
      selectedModeId === 'claude_code_oauth'
        ? 'The trusted Claude Code SDK runner receives the Claude Code OAuth token; tools and skills do not.'
        : 'Sandboxed agent runners receive only a loopback gateway URL and a short-lived gtw_* token.',
      selectedModeId === 'claude_code_oauth'
        ? 'Claude Code owns the OAuth auth path; Gantry only stores and scopes the projection.'
        : 'The trusted host injects the real provider auth only when forwarding approved model API calls.',
    ].join('\n'),
    'Model Access',
  );
  const captureChoice = await p.select({
    message: 'Store this model credential now?',
    options: [
      {
        value: 'store',
        label: 'Store now',
        hint: 'Recommended: finish Model Access setup in this flow.',
      },
      {
        value: 'defer',
        label: 'Do later',
        hint: `Show the exact \`gantry credentials model set ${provider.id}\` command.`,
      },
    ],
  });
  if (p.isCancel(captureChoice)) return { type: 'cancel' };
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
  p.note(
    [
      `${provider.label} uses ${selectedCredentialMode?.label ?? selectedModeId} credentials.`,
      `Run \`gantry credentials model set ${provider.id}\` after setup to store the credential.`,
      selectedModeId === 'claude_code_oauth'
        ? 'The agent runner receives the OAuth token only in the private Claude Code SDK model credential env.'
        : 'The agent runner receives a loopback gateway token, not raw provider keys.',
      'Channel, Postgres, and runtime-owned secrets still stay in runtime .env.',
    ].join('\n'),
    'Model Access',
  );
  return { type: 'next' };
}
