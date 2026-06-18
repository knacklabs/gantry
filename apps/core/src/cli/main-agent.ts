import fs from 'fs';
import path from 'path';

import { DEFAULT_AGENT_NAME } from '../shared/default-agent.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
export { defaultTriggerForAgentName } from '../shared/trigger-pattern.js';

export const DEFAULT_AGENT_CLI_NAME = DEFAULT_AGENT_NAME;
export const DEFAULT_AGENT_FOLDER = 'main_agent';

export function normalizeDefaultAgentName(raw: string | undefined): string {
  return raw?.trim() || DEFAULT_AGENT_CLI_NAME;
}

export function defaultAgentNameFromSettings(settings: {
  agent: { name?: string };
}): string {
  return normalizeDefaultAgentName(settings.agent.name);
}

export function allocateDefaultAgentFolder(
  runtimeHome: string,
  existing: Record<string, { folder: string }>,
): string {
  const used = new Set(Object.values(existing).map((group) => group.folder));
  const hasOnDiskFolder = (folder: string): boolean =>
    fs.existsSync(path.join(runtimeHome, 'agents', folder));

  if (
    !used.has(DEFAULT_AGENT_FOLDER) &&
    !hasOnDiskFolder(DEFAULT_AGENT_FOLDER)
  ) {
    return DEFAULT_AGENT_FOLDER;
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${DEFAULT_AGENT_FOLDER}_${i}`;
    if (!used.has(candidate) && !hasOnDiskFolder(candidate)) return candidate;
  }
  return `${DEFAULT_AGENT_FOLDER}_${currentTimeMs()}`;
}

export function displayAgentName(
  group: { name: string },
  configuredDefaultAgentName?: string,
) {
  void configuredDefaultAgentName;
  return group.name;
}
