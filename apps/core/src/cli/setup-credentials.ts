import * as p from '@clack/prompts';
import { OneCLI } from '@onecli-sh/sdk';

import type { HostCredentialMode } from '../core/credential-mode.js';

export interface CredentialSetupDraft {
  credentialMode: HostCredentialMode;
  onecliUrl: string;
}

export type CredentialStepAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' };

async function validateOneCLIReachability(
  onecliUrl: string,
): Promise<{ ok: boolean; message: string }> {
  const client = new OneCLI({ url: onecliUrl });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.getContainerConfig(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('connection timed out after 8 seconds'));
        }, 8_000);
      }),
    ]);
    return { ok: true, message: `Connected to OneCLI at ${onecliUrl}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `OneCLI check failed for ${onecliUrl}: ${message}`,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function runCredentialsStep(
  draft: CredentialSetupDraft,
): Promise<CredentialStepAction> {
  p.note(
    [
      'Choose where host-agent credentials come from.',
      'You can use only local runtime .env, only OneCLI, or hybrid mode.',
    ].join('\n'),
    'Agent Credentials',
  );

  while (true) {
    const modeValue = await p.select({
      message: 'Credential source mode',
      options: [
        {
          value: 'env-only',
          label: 'Local .env only (Recommended)',
          hint: 'Use credentials from runtime .env only.',
        },
        {
          value: 'hybrid',
          label: 'Hybrid (.env + OneCLI)',
          hint: 'Use .env fallback and prefer OneCLI values when both exist.',
        },
        {
          value: 'onecli-only',
          label: 'OneCLI only',
          hint: 'Require OneCLI and do not fall back to .env credentials.',
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
      initialValue: draft.credentialMode,
    });

    if (p.isCancel(modeValue)) return { type: 'resume' };
    if (modeValue === 'back') return { type: 'back' };
    if (modeValue === 'resume') return { type: 'resume' };
    if (modeValue === 'cancel') return { type: 'cancel' };

    draft.credentialMode = modeValue as HostCredentialMode;
    if (draft.credentialMode === 'env-only') {
      draft.onecliUrl = '';
      p.note(
        'Credential mode set to env-only. Host agents will read runtime .env only.',
        'Agent Credentials',
      );
      return { type: 'next' };
    }

    const onecliUrlInput = await p.text({
      message: 'Enter OneCLI gateway URL',
      placeholder: 'http://localhost:10254',
      defaultValue: draft.onecliUrl || 'http://localhost:10254',
      validate: (input) => {
        const trimmed = String(input ?? '').trim();
        if (!trimmed) {
          return 'OneCLI URL is required for this mode.';
        }
        if (!/^https?:\/\//i.test(trimmed)) {
          return 'Use an http:// or https:// URL.';
        }
        return undefined;
      },
    });
    if (p.isCancel(onecliUrlInput)) return { type: 'resume' };
    draft.onecliUrl = String(onecliUrlInput).trim();

    const spinner = p.spinner();
    spinner.start('Validating OneCLI connectivity...');
    const check = await validateOneCLIReachability(draft.onecliUrl);
    spinner.stop(
      check.ok ? 'OneCLI validation passed' : 'OneCLI validation failed',
    );

    if (check.ok) {
      p.note(check.message, 'Agent Credentials');
      return { type: 'next' };
    }

    p.note(
      `${check.message}\nNext action: confirm OneCLI URL and gateway availability.`,
      'OneCLI Validation',
    );

    const followUp = await p.select({
      message:
        draft.credentialMode === 'onecli-only'
          ? 'OneCLI-only mode requires a reachable OneCLI gateway.'
          : 'Hybrid mode can continue with .env fallback if OneCLI is unavailable.',
      options:
        draft.credentialMode === 'onecli-only'
          ? [
              {
                value: 'retry',
                label: 'Retry OneCLI check (Recommended)',
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
            ]
          : [
              {
                value: 'continue',
                label: 'Continue with .env fallback (Recommended)',
              },
              {
                value: 'retry',
                label: 'Retry OneCLI check',
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
    if (p.isCancel(followUp)) return { type: 'resume' };
    if (followUp === 'retry') {
      continue;
    }
    if (followUp === 'continue' && draft.credentialMode === 'hybrid') {
      return { type: 'next' };
    }
    if (followUp === 'back') return { type: 'back' };
    if (followUp === 'resume') return { type: 'resume' };
    return { type: 'cancel' };
  }
}
