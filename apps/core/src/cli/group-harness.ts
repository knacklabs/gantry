import * as p from '@clack/prompts';

import {
  loadRuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { isAgentHarness, type AgentHarness } from '../shared/agent-engine.js';
import { loadDatabase, resolveGroupSelector } from './group-helpers.js';

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function parseArgs(
  args: string[],
): { selector: string; agentHarness: AgentHarness } | { error: string } {
  const [selector, agentHarness, ...rest] = args;
  if (!selector || !agentHarness || rest.length > 0) {
    return {
      error:
        'Usage: gantry agent harness <jid|folder> <auto|anthropic_sdk|deepagents>',
    };
  }
  if (!isAgentHarness(agentHarness)) {
    return {
      error: 'Agent harness must be one of auto, anthropic_sdk, or deepagents.',
    };
  }
  return { selector, agentHarness };
}

export async function runHarness(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }

  const db = await loadDatabase(runtimeHome).catch((err) => {
    p.log.error(`Could not open runtime database: ${errorMessage(err)}`);
    return null;
  });
  if (!db) return 1;

  try {
    const groups = await db.getAllConversationRoutes();
    const resolved = resolveGroupSelector(groups, parsed.selector);
    if (resolved.error) {
      p.log.error(resolved.error);
      return 1;
    }
    if (!resolved.found) {
      p.log.error(`No agent found for selector "${parsed.selector.trim()}".`);
      return 1;
    }

    const folder = resolved.found.group.folder;
    const settings = loadRuntimeSettings(runtimeHome);
    const previousSettings = structuredClone(settings);
    const existing = settings.agents[folder];
    settings.agents[folder] = {
      ...existing,
      name: resolved.found.group.name || folder,
      folder,
      bindings: existing?.bindings ?? {},
      sources: existing?.sources ?? { skills: [], mcpServers: [], tools: [] },
      capabilities: existing?.capabilities ?? [],
      accessPreset: existing?.accessPreset ?? 'full',
      agentHarness: parsed.agentHarness,
    };
    await writeDesiredRuntimeSettings({
      runtimeHome,
      settings,
      previousSettings,
    });
    p.log.success(`Agent harness for ${folder} set to ${parsed.agentHarness}.`);
    p.log.info('Restart Gantry for running processes to pick up the change.');
    return 0;
  } catch (err) {
    p.log.error(`Could not update agent harness: ${errorMessage(err)}`);
    return 1;
  } finally {
    await db.close();
  }
}
