import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  resolveModelSelectionForWorkload,
} from '../shared/model-catalog.js';
import { deriveAgentEngineForProvider } from '../shared/model-execution-route.js';
import { agentEngineLabel, type AgentEngine } from '../shared/agent-engine.js';

// Derived engine for an agent folder: the engine is read-only and follows the
// agent's effective model provider (per-agent model else the configured
// default). There is no per-agent engine override anymore.
export function derivedAgentEngineForFolder(
  settings: RuntimeSettings,
  folder: string,
): AgentEngine {
  const effectiveModel = (
    settings.agents[folder]?.model ||
    settings.agent.defaultModel ||
    DEFAULT_SETUP_MODEL_ALIAS
  ).trim();
  const resolved = resolveModelSelectionForWorkload(effectiveModel, 'chat');
  return resolved.ok
    ? deriveAgentEngineForProvider(resolved.entry.modelRoute.id)
    : deriveAgentEngineForProvider('');
}

// Engine label cell for the `gantry agent list` table.
export function formatAgentEngineCell(
  settings: RuntimeSettings,
  folder: string,
): string {
  return agentEngineLabel(derivedAgentEngineForFolder(settings, folder));
}

// One-line engine descriptor for the `gantry agent` detail verb.
export function formatAgentEngineLine(
  settings: RuntimeSettings,
  folder: string,
): string {
  return `Agent engine: ${formatAgentEngineCell(settings, folder)}`;
}
