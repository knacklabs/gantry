// Public agent-engine vocabulary. This module is the single source of the SDK
// engine value outside the provider adapter and the contracts zod enum; every
// other module references the exported constants so the provider-boundary
// architecture gate stays count-exact. The SDK engine is the system default and
// the Claude OAuth/subscription lane; DeepAgents is the API-key engine. See
// docs/architecture/deepagents-agent-engine-handoff-plan.md.

export const DEEPAGENTS_ENGINE = 'deepagents';

// The literal lives here exactly once. `DEFAULT_AGENT_ENGINE` is the only
// exported handle to it, so consumers never restate the provider literal.
export const DEFAULT_AGENT_ENGINE = 'anthropic_sdk';

export const AGENT_ENGINES = [DEFAULT_AGENT_ENGINE, DEEPAGENTS_ENGINE] as const;

export type AgentEngine = (typeof AGENT_ENGINES)[number];

const AGENT_ENGINE_LABELS: Record<AgentEngine, string> = {
  [DEFAULT_AGENT_ENGINE]: 'Anthropic SDK',
  [DEEPAGENTS_ENGINE]: 'DeepAgents',
};

export function agentEngineLabel(engine: AgentEngine): string {
  return AGENT_ENGINE_LABELS[engine];
}

export function isAgentEngine(value: unknown): value is AgentEngine {
  return (
    typeof value === 'string' &&
    (AGENT_ENGINES as readonly string[]).includes(value)
  );
}

function normalizeAgentEngineInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

// Lenient resolution for runtime read paths: an unknown value falls back to the
// system default rather than throwing.
export function resolveAgentEngine(value: unknown): AgentEngine {
  if (typeof value !== 'string') return DEFAULT_AGENT_ENGINE;
  const normalized = normalizeAgentEngineInput(value);
  return isAgentEngine(normalized) ? normalized : DEFAULT_AGENT_ENGINE;
}

// Strict parsing for settings/config edges: an unknown value throws with the
// locked plan copy. When `path` is provided the message is prefixed with it for
// settings/document errors; CLI/API edges pass no path to surface the bare
// locked copy.
export function parseAgentEngine(value: unknown, path?: string): AgentEngine {
  if (value === undefined) return DEFAULT_AGENT_ENGINE;
  if (typeof value !== 'string') {
    throw new Error(unsupportedAgentEngineMessage(value, path));
  }
  const normalized = normalizeAgentEngineInput(value);
  if (!isAgentEngine(normalized)) {
    throw new Error(unsupportedAgentEngineMessage(value, path));
  }
  return normalized;
}

// Locked plan copy for an unsupported engine value. The provider literals live
// only in this module, so every surface that needs this copy imports it here.
export function unsupportedAgentEngineMessage(
  value: unknown,
  path?: string,
): string {
  const display = typeof value === 'string' ? value : String(value);
  const message = `Unsupported agent engine: ${display}. Choose ${DEFAULT_AGENT_ENGINE} or ${DEEPAGENTS_ENGINE}.`;
  return path ? `${path}: ${message}` : message;
}
