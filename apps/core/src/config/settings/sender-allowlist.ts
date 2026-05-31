import { isValidWorkspaceFolder } from '../../platform/workspace-folder-rules.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  agents: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

const DEFAULT_SENDER_ALLOWLIST: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  agents: {},
  logDenied: true,
};

export function createDefaultSenderAllowlist(): SenderAllowlistConfig {
  return {
    default: { ...DEFAULT_SENDER_ALLOWLIST.default },
    agents: {},
    logDenied: DEFAULT_SENDER_ALLOWLIST.logDenied,
  };
}

function isValidAllowlistEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const row = entry as Record<string, unknown>;
  const allow = row.allow;
  const mode = row.mode;
  const validAllow =
    allow === '*' ||
    (Array.isArray(allow) &&
      allow.every((item) => typeof item === 'string' && item.trim()));
  const validMode = mode === 'trigger' || mode === 'drop';
  return validAllow && validMode;
}

function normalizeAllowlistEntry(
  entry: ChatAllowlistEntry,
): ChatAllowlistEntry {
  return {
    allow: entry.allow === '*' ? '*' : entry.allow.map((value) => value.trim()),
    mode: entry.mode,
  };
}

export function parseSenderAllowlistConfig(
  raw: unknown,
  pathPrefix: string,
): SenderAllowlistConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }

  const map = raw as Record<string, unknown>;
  if (!isValidAllowlistEntry(map.default)) {
    throw new Error(`${pathPrefix}.default must include allow and mode`);
  }

  const agentsRaw = map.agents;
  if (
    typeof agentsRaw !== 'object' ||
    agentsRaw === null ||
    Array.isArray(agentsRaw)
  ) {
    throw new Error(`${pathPrefix}.agents must be a mapping`);
  }

  const agents: Record<string, ChatAllowlistEntry> = {};
  for (const [folder, entry] of Object.entries(
    agentsRaw as Record<string, unknown>,
  )) {
    const trimmedFolder = folder.trim();
    if (!trimmedFolder) throw new Error(`${pathPrefix}.agents has empty key`);
    if (!isValidWorkspaceFolder(trimmedFolder)) {
      throw new Error(
        `${pathPrefix}.agents.${trimmedFolder} must use a valid agent folder key`,
      );
    }
    if (!isValidAllowlistEntry(entry)) {
      throw new Error(`${pathPrefix}.agents.${trimmedFolder} is invalid`);
    }
    agents[trimmedFolder] = normalizeAllowlistEntry(entry);
  }

  if (typeof map.log_denied !== 'boolean') {
    throw new Error(`${pathPrefix}.log_denied must be true/false`);
  }

  return {
    default: normalizeAllowlistEntry(map.default as ChatAllowlistEntry),
    agents,
    logDenied: map.log_denied,
  };
}

function renderAllowValue(allow: '*' | string[]): string {
  if (allow === '*') return '"*"';
  return JSON.stringify(allow);
}

export function renderSenderAllowlistYaml(
  lines: string[],
  indent: string,
  quoteYamlKey: (key: string) => string,
  config: SenderAllowlistConfig,
): void {
  lines.push(`${indent}default:`);
  lines.push(`${indent}  allow: ${renderAllowValue(config.default.allow)}`);
  lines.push(`${indent}  mode: ${config.default.mode}`);
  lines.push(`${indent}agents:`);

  const entries = Object.entries(config.agents).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [folder, entry] of entries) {
    lines.push(`${indent}  ${quoteYamlKey(folder)}:`);
    lines.push(`${indent}    allow: ${renderAllowValue(entry.allow)}`);
    lines.push(`${indent}    mode: ${entry.mode}`);
  }

  lines.push(`${indent}log_denied: ${config.logDenied ? 'true' : 'false'}`);
}
