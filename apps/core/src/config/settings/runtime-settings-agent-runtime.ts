import {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyToolRuleLabels,
  isInlineWorkerOnlyToolRule,
  type AgentRuntime,
} from '../../shared/agent-runtime.js';
import { settingsCapabilityIdToToolRule } from './configured-capability-normalization.js';
import type { RuntimeConfiguredAgent } from './runtime-settings-types.js';

export {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyToolRuleLabels,
};

export function parseAgentRuntimeValue(
  raw: unknown,
  pathPrefix: string,
): AgentRuntime {
  if (raw === undefined) return 'worker';
  if (raw === 'worker' || raw === 'inline') return raw;
  throw new Error(`${pathPrefix} must be worker or inline`);
}

export function resolveConfiguredAgentRuntime(
  agent: Pick<RuntimeConfiguredAgent, 'runtime'> | undefined,
): AgentRuntime {
  return agent?.runtime ?? 'worker';
}

export function inlineWorkerOnlyConfiguredCapabilityLabels(input: {
  agent: RuntimeConfiguredAgent;
  stdioMcpServerIds?: ReadonlySet<string>;
}): string[] {
  if (resolveConfiguredAgentRuntime(input.agent) !== 'inline') return [];
  const labels = new Set<string>();
  for (const source of input.agent.sources.skills) labels.add(source.id);
  for (const source of input.agent.sources.tools) {
    if (source.kind === 'local_cli') labels.add(source.id);
  }
  for (const source of input.agent.sources.mcpServers) {
    if (input.stdioMcpServerIds?.has(source.id)) labels.add(source.id);
  }
  for (const capability of input.agent.capabilities) {
    const rule = settingsCapabilityIdToToolRule(capability.id);
    if (isInlineWorkerOnlyToolRule(rule)) labels.add(capability.id);
  }
  return [...labels].sort();
}
