import * as p from '@clack/prompts';

import { loadRuntimeSettings } from '../config/settings/runtime-settings.js';
import { writeDesiredRuntimeSettings } from '../config/settings/desired-settings-writer.js';
import type { RuntimeSettings } from '../config/settings/runtime-settings-types.js';
import {
  AGENT_ENGINES,
  agentEngineLabel,
  parseAgentEngine,
  resolveAgentEngine,
  type AgentEngine,
} from '../shared/agent-engine.js';

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Effective engine for an agent folder: per-agent override else the configured
// default. `isOverride` distinguishes a per-agent selection from the inherited
// default so list/detail can show which agents diverge from the default.
export function effectiveAgentEngineForFolder(
  settings: RuntimeSettings,
  folder: string,
): { engine: AgentEngine; isOverride: boolean } {
  const perAgent = settings.agents[folder]?.agentEngine;
  return {
    engine: resolveAgentEngine(perAgent ?? settings.agent.defaultAgentEngine),
    isOverride: perAgent !== undefined,
  };
}

// Engine label with a `(default)` annotation when the agent inherits the
// configured default rather than carrying a per-agent override.
export function formatAgentEngineCell(
  settings: RuntimeSettings,
  folder: string,
): string {
  const { engine, isOverride } = effectiveAgentEngineForFolder(
    settings,
    folder,
  );
  return `${agentEngineLabel(engine)}${isOverride ? '' : ' (default)'}`;
}

// One-line engine descriptor for the `gantry agent` detail verb.
export function formatAgentEngineLine(
  settings: RuntimeSettings,
  folder: string,
): string {
  return `Agent engine: ${formatAgentEngineCell(settings, folder)}`;
}

function agentFolderFromSelector(value: string): string {
  return value.trim().replace(/^agent:/, '');
}

// `gantry agent engine <id> <engine>` — mirrors the access-preset verb: it
// writes through the settings desired-state path so settings.yaml is updated and
// reconciled in the same operation. Valid engine values come from AGENT_ENGINES.
// Validation failures surface the locked shared-helper copy (engine parse copy,
// and the model/engine pair copy from settings validation).
export async function runEngine(
  runtimeHome: string,
  rest: string[],
): Promise<number> {
  const [selector, rawEngine] = rest;
  if (!selector || !rawEngine) {
    p.log.error(
      `Usage: gantry agent engine <jid|folder> <${AGENT_ENGINES.join('|')}>`,
    );
    return 1;
  }
  let agentEngine: AgentEngine;
  try {
    agentEngine = parseAgentEngine(rawEngine);
  } catch (err) {
    p.log.error(errorMessage(err));
    return 1;
  }
  const folder = agentFolderFromSelector(selector);
  try {
    const previousSettings = loadRuntimeSettings(runtimeHome);
    const agent = previousSettings.agents[folder];
    if (!agent) {
      p.log.error(
        `No configured agent named "${folder}". Run "gantry agent list" to see configured agents.`,
      );
      return 1;
    }
    if (agent.agentEngine === agentEngine) {
      p.log.success(
        `Agent engine updated: ${folder} now uses ${agentEngineLabel(
          agentEngine,
        )}. Existing jobs and conversations use this engine on their next run.`,
      );
      return 0;
    }
    const settings = {
      ...previousSettings,
      agents: {
        ...previousSettings.agents,
        [folder]: {
          ...agent,
          agentEngine,
        },
      },
    };
    await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
    });
    p.log.success(
      `Agent engine updated: ${folder} now uses ${agentEngineLabel(
        agentEngine,
      )}. Existing jobs and conversations use this engine on their next run.`,
    );
    return 0;
  } catch (err) {
    p.log.error(`Agent engine command failed: ${errorMessage(err)}`);
    return 1;
  }
}
