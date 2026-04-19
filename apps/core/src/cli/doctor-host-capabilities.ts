import { resolveHostCredentialMode } from '../core/credential-mode.js';
import {
  DEFAULT_HOST_CAPABILITIES,
  detectGoogleWorkspaceCli,
  isOnecliInstalled,
} from '../platform/host-capabilities.js';

import type { DoctorCheck } from './doctor.js';
import type { EnvMap } from './env-file.js';
import type { RuntimeSettings as SettingsFile } from './runtime-settings.js';

export function getOptionalHostCapabilitiesCheck(
  env: EnvMap,
  settings?: SettingsFile,
): DoctorCheck | undefined {
  const onecliUrl = env.ONECLI_URL?.trim() || '';
  const credentialMode = resolveHostCredentialMode(
    env.MYCLAW_CREDENTIAL_MODE,
    onecliUrl,
  );
  const hostCapabilities =
    settings?.hostCapabilities || DEFAULT_HOST_CAPABILITIES;
  const googleWorkspaceSettings = hostCapabilities.googleWorkspace;
  const googleWorkspaceCli = detectGoogleWorkspaceCli(googleWorkspaceSettings);
  const onecliInstalled =
    googleWorkspaceCli?.onecliInstalled || isOnecliInstalled();
  const googleWorkspaceInstalled = Boolean(googleWorkspaceCli);
  const configuredGoogleCommand =
    googleWorkspaceSettings.command === 'auto'
      ? 'gws'
      : googleWorkspaceSettings.command;
  const googleWorkspaceCommand =
    googleWorkspaceCli?.command || configuredGoogleCommand;
  const googleWorkspaceEnabled = googleWorkspaceSettings.mode !== 'off';

  if (!googleWorkspaceEnabled) {
    return undefined;
  }

  if (
    googleWorkspaceSettings.mode === 'auto' &&
    credentialMode === 'env-only' &&
    !onecliInstalled &&
    !googleWorkspaceInstalled
  ) {
    return undefined;
  }

  if (!googleWorkspaceInstalled) {
    return {
      id: 'host-capabilities',
      title: 'Optional Host Capabilities',
      status: googleWorkspaceSettings.mode === 'on' ? 'warn' : 'pass',
      message:
        googleWorkspaceSettings.mode === 'on'
          ? `Google Workspace access is enabled in settings.yaml, but the configured CLI (\`${googleWorkspaceCommand}\`) is not installed in this shell.`
          : `Google Workspace access is optional in settings.yaml, and the configured CLI (\`${googleWorkspaceCommand}\`) is not installed in this shell yet.`,
      nextAction:
        googleWorkspaceSettings.mode === 'on'
          ? 'Install the configured Google Workspace CLI on the host or update `host_capabilities.google_workspace.command` in settings.yaml.'
          : 'Install the configured Google Workspace CLI when you want Gmail, Sheets, Calendar, or Forms access on this VM.',
    };
  }

  if (!onecliInstalled) {
    return {
      id: 'host-capabilities',
      title: 'Optional Host Capabilities',
      status: 'warn',
      message: googleWorkspaceSettings.useOnecli
        ? `Google Workspace CLI (\`${googleWorkspaceCommand}\`) is installed, but onecli is missing. Credentialed host CLIs should run through \`onecli exec -- ...\` when available.`
        : `Google Workspace CLI (\`${googleWorkspaceCommand}\`) is installed and configured for direct use without OneCLI.`,
      nextAction: googleWorkspaceSettings.useOnecli
        ? 'Install OneCLI on the host, register credentials there, and route external CLI access through `onecli exec -- <cli>`.'
        : 'Authenticate the CLI on the host and keep `.env` limited to runtime secrets and endpoints.',
    };
  }

  return {
    id: 'host-capabilities',
    title: 'Optional Host Capabilities',
    status: 'pass',
    message: googleWorkspaceSettings.useOnecli
      ? `OneCLI and Google Workspace CLI (\`${googleWorkspaceCommand}\`) are installed. Google Workspace access should run as \`onecli exec -- ${googleWorkspaceCommand} ...\`.`
      : `Google Workspace CLI (\`${googleWorkspaceCommand}\`) is installed and direct host use is enabled in settings.yaml.`,
    nextAction: googleWorkspaceSettings.useOnecli
      ? 'Keep Google credentials out of repo files and wrap Sheets, Gmail, Calendar, and Forms commands with `onecli exec -- ...`.'
      : 'Keep Google credentials out of settings.yaml and prefer host-level auth storage for the CLI.',
  };
}
