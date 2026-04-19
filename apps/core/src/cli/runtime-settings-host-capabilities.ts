import {
  DEFAULT_HOST_CAPABILITIES,
  type FastLookupCapabilitySettings,
  type GoogleWorkspaceCapabilitySettings,
  type GoogleWorkspaceCliPreference,
  type HostCapabilitiesSettings,
  type HostCapabilityMode,
} from '../platform/host-capabilities.js';

export function createDefaultHostCapabilities(): HostCapabilitiesSettings {
  return {
    googleWorkspace: {
      ...DEFAULT_HOST_CAPABILITIES.googleWorkspace,
    },
    fastLookup: {
      ...DEFAULT_HOST_CAPABILITIES.fastLookup,
    },
  };
}

function parseGoogleWorkspaceMode(
  value: unknown,
  pathPrefix: string,
): HostCapabilityMode {
  if (value === 'auto' || value === 'on' || value === 'off') {
    return value;
  }
  throw new Error(`${pathPrefix}.mode must be auto, on, or off`);
}

function parseGoogleWorkspaceCommand(
  value: unknown,
  pathPrefix: string,
): GoogleWorkspaceCliPreference {
  if (value === 'auto' || value === 'gws' || value === 'gworkspace') {
    return value;
  }
  throw new Error(`${pathPrefix}.command must be auto, gws, or gworkspace`);
}

function parseGoogleWorkspaceCapabilitySettings(
  raw: unknown,
  pathPrefix: string,
): GoogleWorkspaceCapabilitySettings {
  const defaults = createDefaultHostCapabilities().googleWorkspace;
  if (raw === undefined) {
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }

  const map = raw as Record<string, unknown>;
  const useOnecli = map.use_onecli;

  if (typeof useOnecli !== 'boolean') {
    throw new Error(`${pathPrefix}.use_onecli must be true/false`);
  }

  return {
    mode: parseGoogleWorkspaceMode(map.mode, pathPrefix),
    command: parseGoogleWorkspaceCommand(map.command, pathPrefix),
    useOnecli,
  };
}

function parseFastLookupCapabilitySettings(
  raw: unknown,
  pathPrefix: string,
): FastLookupCapabilitySettings {
  const defaults = createDefaultHostCapabilities().fastLookup;
  if (raw === undefined) {
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }

  const map = raw as Record<string, unknown>;
  if (typeof map.enabled !== 'boolean') {
    throw new Error(`${pathPrefix}.enabled must be true/false`);
  }

  return {
    enabled: map.enabled,
  };
}

export function parseHostCapabilitiesSettings(
  raw: unknown,
): HostCapabilitiesSettings {
  const defaults = createDefaultHostCapabilities();
  if (raw === undefined) {
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('host_capabilities must be a mapping');
  }

  const map = raw as Record<string, unknown>;
  return {
    googleWorkspace: parseGoogleWorkspaceCapabilitySettings(
      map.google_workspace,
      'host_capabilities.google_workspace',
    ),
    fastLookup: parseFastLookupCapabilitySettings(
      map.fast_lookup,
      'host_capabilities.fast_lookup',
    ),
  };
}

export function renderHostCapabilitiesYaml(
  lines: string[],
  settings: HostCapabilitiesSettings,
): void {
  lines.push(
    'host_capabilities:',
    '  google_workspace:',
    `    mode: ${settings.googleWorkspace.mode}`,
    `    command: ${settings.googleWorkspace.command}`,
    `    use_onecli: ${settings.googleWorkspace.useOnecli ? 'true' : 'false'}`,
    '  fast_lookup:',
    `    enabled: ${settings.fastLookup.enabled ? 'true' : 'false'}`,
  );
}
