import { execFileSync } from 'child_process';
import fs from 'fs';

export interface GoogleWorkspaceCliCapability {
  command: 'gws' | 'gworkspace';
  onecliInstalled: boolean;
}

export type HostCapabilityMode = 'auto' | 'on' | 'off';
export type GoogleWorkspaceCliPreference = 'auto' | 'gws' | 'gworkspace';

export interface GoogleWorkspaceCapabilitySettings {
  mode: HostCapabilityMode;
  command: GoogleWorkspaceCliPreference;
  useOnecli: boolean;
}

export interface FastLookupCapabilitySettings {
  enabled: boolean;
}

export interface HostCapabilitiesSettings {
  googleWorkspace: GoogleWorkspaceCapabilitySettings;
  fastLookup: FastLookupCapabilitySettings;
}

export const DEFAULT_HOST_CAPABILITIES: HostCapabilitiesSettings = {
  googleWorkspace: {
    mode: 'auto',
    command: 'auto',
    useOnecli: true,
  },
  fastLookup: {
    enabled: true,
  },
};

export const DISABLED_HOST_CAPABILITIES: HostCapabilitiesSettings = {
  googleWorkspace: {
    mode: 'off',
    command: 'auto',
    useOnecli: true,
  },
  fastLookup: {
    enabled: false,
  },
};

const commandExistsCache = new Map<string, boolean>();
const googleWorkspaceCliCache = new Map<
  `${HostCapabilityMode}:${GoogleWorkspaceCliPreference}`,
  GoogleWorkspaceCliCapability | null
>();

const DEFAULT_CA_BUNDLE_CANDIDATES = [
  '/etc/ssl/cert.pem',
  '/opt/homebrew/etc/openssl@3/cert.pem',
] as const;

function commandExists(command: string): boolean {
  const cached = commandExistsCache.get(command);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const detector = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(detector, [command], { stdio: 'ignore' });
    commandExistsCache.set(command, true);
    return true;
  } catch {
    commandExistsCache.set(command, false);
    return false;
  }
}

export function isOnecliInstalled(): boolean {
  return commandExists('onecli');
}

function resolveGoogleWorkspaceCommands(
  preferredCommand: GoogleWorkspaceCliPreference,
): ReadonlyArray<'gws' | 'gworkspace'> {
  if (preferredCommand === 'gws') return ['gws'];
  if (preferredCommand === 'gworkspace') return ['gworkspace'];
  return ['gws', 'gworkspace'];
}

export function detectGoogleWorkspaceCli(
  settings: GoogleWorkspaceCapabilitySettings = DEFAULT_HOST_CAPABILITIES.googleWorkspace,
): GoogleWorkspaceCliCapability | undefined {
  if (settings.mode === 'off') {
    return undefined;
  }

  const cacheKey =
    `${settings.mode}:${settings.command}` as `${HostCapabilityMode}:${GoogleWorkspaceCliPreference}`;
  const cached = googleWorkspaceCliCache.get(cacheKey);
  if (cached !== undefined) {
    return cached || undefined;
  }

  const commandOrder = resolveGoogleWorkspaceCommands(settings.command);
  const onecliInstalled = isOnecliInstalled();

  for (const command of commandOrder) {
    if (commandExists(command)) {
      const capability = { command, onecliInstalled } as const;
      googleWorkspaceCliCache.set(cacheKey, capability);
      return capability;
    }
  }

  googleWorkspaceCliCache.set(cacheKey, null);
  return undefined;
}

export function buildGoogleWorkspaceCapabilityPromptText(
  settings: GoogleWorkspaceCapabilitySettings = DEFAULT_HOST_CAPABILITIES.googleWorkspace,
): string {
  const capability = detectGoogleWorkspaceCli(settings);
  if (!capability) return '';

  const commandLabel = `\`${capability.command}\``;
  const useWrappedCommands = settings.useOnecli && capability.onecliInstalled;
  const commandPrefix = useWrappedCommands
    ? `onecli exec -- ${capability.command}`
    : capability.command;
  const wrappedCommand = `\`${commandPrefix}\``;
  const lines = [
    'Host capability detected: Google Workspace CLI is available in this runtime.',
    `CLI command: ${commandLabel}.`,
    useWrappedCommands
      ? `Use ${wrappedCommand} for Gmail, Sheets, Calendar, and Forms operations.`
      : settings.useOnecli
        ? `OneCLI is not installed in this shell, so use ${wrappedCommand} only if host Google auth is already configured.`
        : `Use ${wrappedCommand} directly for Gmail, Sheets, Calendar, and Forms operations in this runtime.`,
    `Before claiming Gmail access, check auth with \`${commandPrefix} auth status\`.`,
    `If auth is missing or \`auth_method\` is \`none\`, ask the user to run \`${capability.command} auth login\` and do not claim mailbox access yet.`,
    `If auth looks present, verify readiness with \`${commandPrefix} gmail users profile get --params '{"userId":"me"}'\`.`,
    `Only after that succeeds should you fetch latest mail with \`${commandPrefix} gmail users messages list --params '{"userId":"me","maxResults":1}'\`.`,
    'If the readiness check fails, report the exact failure reason instead of saying Gmail access works.',
  ];

  return lines.join('\n');
}

export function buildGoogleWorkspaceCliEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  settings: GoogleWorkspaceCapabilitySettings = DEFAULT_HOST_CAPABILITIES.googleWorkspace,
): Record<string, string> {
  if (!detectGoogleWorkspaceCli(settings)) return {};

  const env: Record<string, string> = {};

  if (!sourceEnv.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND) {
    env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND = 'file';
  }

  if (!sourceEnv.SSL_CERT_FILE) {
    const bundle = DEFAULT_CA_BUNDLE_CANDIDATES.find((candidate) =>
      fs.existsSync(candidate),
    );
    if (bundle) {
      env.SSL_CERT_FILE = bundle;
    }
  }

  return env;
}

export function buildFastLookupCapabilityPromptText(
  settings: FastLookupCapabilitySettings = DEFAULT_HOST_CAPABILITIES.fastLookup,
): string {
  if (!settings.enabled) return '';

  return [
    'For up-to-date questions about weather, prices, news, schedules, sports, or anything phrased as `today`, `latest`, or `current`, start with the MyClaw MCP tool `mcp__myclaw__fast_lookup`.',
    'Use mode `lookup` for quick factual/current-info questions, `weather` for weather-only questions, and `search` for general quick web results.',
    'If the fast lookup returns promising result URLs but you need more detail before answering, use `WebFetch` on the strongest source.',
    'Do not answer live questions from memory, and do not stop after a failed `WebSearch` attempt while `mcp__myclaw__fast_lookup` is available.',
    'If you do use `WebSearch` or `WebFetch` and it fails, say which tool failed briefly, then continue with `mcp__myclaw__fast_lookup`.',
    'Do not tell the user to check Google, Weather.com, Cricbuzz, or another site themselves while `mcp__myclaw__fast_lookup` is still available.',
    'Fast host lookup is available through the MyClaw MCP tool `mcp__myclaw__fast_lookup` and should be the default path for short live-search questions in this runtime.',
    'The tool returns concise JSON. Summarize the answer directly instead of pasting raw JSON.',
    'If the fast lookup tool also fails, report the exact failure briefly instead of saying only that retrieval failed.',
  ].join('\n');
}

export function buildHostCapabilityPromptText(
  settings: HostCapabilitiesSettings = DEFAULT_HOST_CAPABILITIES,
): string {
  return [
    buildGoogleWorkspaceCapabilityPromptText(settings.googleWorkspace),
    buildFastLookupCapabilityPromptText(settings.fastLookup),
  ]
    .filter((block) => block.trim().length > 0)
    .join('\n\n');
}
