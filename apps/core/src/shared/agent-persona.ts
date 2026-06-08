export const AGENT_PERSONAS = [
  'developer',
  'generalist',
  'sales',
  'marketing',
  'operations',
  'research',
] as const;

export type AgentPersona = (typeof AGENT_PERSONAS)[number];

export const DEFAULT_AGENT_PERSONA: AgentPersona = 'developer';
export const UNKNOWN_AGENT_PERSONA_FALLBACK: AgentPersona = 'generalist';

export function resolveAgentPersona(value: unknown): AgentPersona {
  if (typeof value !== 'string') return DEFAULT_AGENT_PERSONA;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  return (AGENT_PERSONAS as readonly string[]).includes(normalized)
    ? (normalized as AgentPersona)
    : UNKNOWN_AGENT_PERSONA_FALLBACK;
}

export function parseAgentPersona(value: unknown, path: string): AgentPersona {
  if (value === undefined) return DEFAULT_AGENT_PERSONA;
  if (typeof value !== 'string') {
    throw new Error(`${path} must be one of ${AGENT_PERSONAS.join(', ')}`);
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (!(AGENT_PERSONAS as readonly string[]).includes(normalized)) {
    throw new Error(`${path} must be one of ${AGENT_PERSONAS.join(', ')}`);
  }
  return normalized as AgentPersona;
}
