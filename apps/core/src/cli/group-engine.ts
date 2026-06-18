import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import {
  AUTO_AGENT_HARNESS,
  type AgentHarness,
} from '../shared/agent-engine.js';

export function selectedAgentHarnessForFolder(
  settings: RuntimeSettings,
  folder: string,
): AgentHarness {
  return (
    settings.agents[folder]?.agentHarness ??
    settings.agent.agentHarness ??
    AUTO_AGENT_HARNESS
  );
}

export function formatAgentHarnessCell(
  settings: RuntimeSettings,
  folder: string,
): string {
  return selectedAgentHarnessForFolder(settings, folder);
}

export function formatAgentHarnessLine(
  settings: RuntimeSettings,
  folder: string,
): string {
  return `Agent harness: ${formatAgentHarnessCell(settings, folder)}`;
}
