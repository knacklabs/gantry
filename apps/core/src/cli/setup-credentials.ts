import * as p from '@clack/prompts';
import { OneCLI } from '@onecli-sh/sdk';

import type { HostCredentialMode } from '../core/credential-mode.js';

export interface CredentialSetupDraft {
  credentialMode: HostCredentialMode;
  onecliUrl: string;
  claudeOauthToken: string;
  anthropicApiKey: string;
}

export type CredentialStepAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'resume' }
  | { type: 'cancel' };

function isInputFlowControl(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === '/back' ||
    normalized === '/resume' ||
    normalized === '/cancel'
  );
}

function parseInputFlowControl(value: unknown): CredentialStepAction | null {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '/back') return { type: 'back' };
  if (normalized === '/resume') return { type: 'resume' };
  if (normalized === '/cancel') return { type: 'cancel' };
  return null;
}

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

async function promptClaudeAuth(
  draft: CredentialSetupDraft,
): Promise<CredentialStepAction | null> {
  const authMode = await p.select({
    message: 'How should MyClaw authenticate with Claude?',
    options: [
      {
        value: 'oauth',
        label: 'Claude OAuth token (Recommended)',
        hint: 'Uses CLAUDE_CODE_OAUTH_TOKEN in runtime .env.',
      },
      {
        value: 'api_key',
        label: 'Anthropic API key',
        hint: 'Uses ANTHROPIC_API_KEY in runtime .env.',
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
    initialValue:
      draft.claudeOauthToken || !draft.anthropicApiKey ? 'oauth' : 'api_key',
  });

  if (p.isCancel(authMode)) return { type: 'resume' };
  if (authMode === 'back') return { type: 'back' };
  if (authMode === 'resume') return { type: 'resume' };
  if (authMode === 'cancel') return { type: 'cancel' };

  if (authMode === 'oauth') {
    let token = draft.claudeOauthToken.trim();
    if (token) {
      const reuse = await p.select({
        message: 'Claude OAuth token',
        options: [
          {
            value: 'use_saved',
            label: 'Use saved token (Recommended)',
          },
          {
            value: 'enter_new',
            label: 'Enter a new token',
          },
        ],
      });
      if (p.isCancel(reuse)) return { type: 'resume' };
      if (reuse === 'enter_new') token = '';
    }
    if (!token) {
      const input = await p.password({
        message: 'Paste CLAUDE_CODE_OAUTH_TOKEN (/back, /resume, /cancel)',
        validate: (value) => {
          const trimmed = String(value ?? '').trim();
          if (isInputFlowControl(trimmed)) return undefined;
          return trimmed ? undefined : 'Claude OAuth token is required.';
        },
      });
      if (p.isCancel(input)) return { type: 'resume' };
      const control = parseInputFlowControl(input);
      if (control) return control;
      token = String(input).trim();
    }
    draft.claudeOauthToken = token;
    draft.anthropicApiKey = '';
    return null;
  }

  let apiKey = draft.anthropicApiKey.trim();
  if (apiKey) {
    const reuse = await p.select({
      message: 'Anthropic API key',
      options: [
        {
          value: 'use_saved',
          label: 'Use saved key (Recommended)',
        },
        {
          value: 'enter_new',
          label: 'Enter a new key',
        },
      ],
    });
    if (p.isCancel(reuse)) return { type: 'resume' };
    if (reuse === 'enter_new') apiKey = '';
  }
  if (!apiKey) {
    const input = await p.password({
      message: 'Paste ANTHROPIC_API_KEY (/back, /resume, /cancel)',
      validate: (value) => {
        const trimmed = String(value ?? '').trim();
        if (isInputFlowControl(trimmed)) return undefined;
        return trimmed ? undefined : 'Anthropic API key is required.';
      },
    });
    if (p.isCancel(input)) return { type: 'resume' };
    const control = parseInputFlowControl(input);
    if (control) return control;
    apiKey = String(input).trim();
  }
  draft.anthropicApiKey = apiKey;
  draft.claudeOauthToken = '';
  return null;
}

export async function runCredentialsStep(
  draft: CredentialSetupDraft,
): Promise<CredentialStepAction> {
  p.note(
    [
      'Choose where host-agent credentials come from.',
      'Default is local .env only (OneCLI disabled).',
      'OneCLI-only never prompts for or persists local Claude credentials.',
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
      const authResult = await promptClaudeAuth(draft);
      if (authResult) return authResult;
      p.note(
        'Credential mode set to env-only. Host agents will read runtime .env only.',
        'Agent Credentials',
      );
      return { type: 'next' };
    }

    const defaultOnecliUrl = draft.onecliUrl || 'http://localhost:10254';
    const onecliUrlInput = await p.text({
      message: 'Enter OneCLI gateway URL (/back, /resume, /cancel)',
      placeholder: 'http://localhost:10254',
      defaultValue: defaultOnecliUrl,
      validate: (input) => {
        const trimmed = String(input ?? '').trim();
        if (isInputFlowControl(trimmed)) return undefined;
        if (!trimmed && defaultOnecliUrl) return undefined;
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
    const onecliControl = parseInputFlowControl(onecliUrlInput);
    if (onecliControl) return onecliControl;
    draft.onecliUrl = String(onecliUrlInput).trim() || defaultOnecliUrl;

    const spinner = p.spinner();
    spinner.start('Validating OneCLI connectivity...');
    const check = await validateOneCLIReachability(draft.onecliUrl);
    spinner.stop(
      check.ok ? 'OneCLI validation passed' : 'OneCLI validation failed',
    );

    if (check.ok) {
      if (draft.credentialMode === 'onecli-only') {
        draft.claudeOauthToken = '';
        draft.anthropicApiKey = '';
        p.note(
          `${check.message}\nCredential mode set to onecli-only. Local Claude credentials will be removed from runtime .env.`,
          'Agent Credentials',
        );
        return { type: 'next' };
      }
      const authResult = await promptClaudeAuth(draft);
      if (authResult) return authResult;
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
      const authResult = await promptClaudeAuth(draft);
      if (authResult) return authResult;
      return { type: 'next' };
    }
    if (followUp === 'back') return { type: 'back' };
    if (followUp === 'resume') return { type: 'resume' };
    return { type: 'cancel' };
  }
}
