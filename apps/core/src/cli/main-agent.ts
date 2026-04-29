import fs from 'fs';
import path from 'path';

import { DEFAULT_AGENT_NAME } from '../shared/default-agent.js';

export const MAIN_AGENT_NAME = DEFAULT_AGENT_NAME;
export const MAIN_AGENT_FOLDER = 'main_agent';

export function normalizeMainAgentName(raw: string | undefined): string {
  return raw?.trim() || MAIN_AGENT_NAME;
}

export function mainAgentNameFromSettings(settings: {
  agent: { name?: string };
}): string {
  return normalizeMainAgentName(settings.agent.name);
}

export function defaultTriggerForAgentName(agentName: string): string {
  return `@${normalizeMainAgentName(agentName)}`;
}

export function allocateMainAgentFolder(
  runtimeHome: string,
  existing: Record<string, { folder: string }>,
): string {
  const used = new Set(Object.values(existing).map((group) => group.folder));
  const hasOnDiskFolder = (folder: string): boolean =>
    fs.existsSync(path.join(runtimeHome, 'agents', folder));

  if (!used.has(MAIN_AGENT_FOLDER) && !hasOnDiskFolder(MAIN_AGENT_FOLDER)) {
    return MAIN_AGENT_FOLDER;
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${MAIN_AGENT_FOLDER}_${i}`;
    if (!used.has(candidate) && !hasOnDiskFolder(candidate)) return candidate;
  }
  return `${MAIN_AGENT_FOLDER}_${Date.now()}`;
}

export function displayAgentName(
  group: { isMain?: boolean; name: string },
  configuredMainAgentName?: string,
) {
  return group.isMain
    ? normalizeMainAgentName(configuredMainAgentName || group.name)
    : group.name;
}
