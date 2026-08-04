export declare const AGENT_PERSONAS: readonly ["developer", "generalist", "sales", "marketing", "operations", "research"];
export type AgentPersona = (typeof AGENT_PERSONAS)[number];
export declare const DEFAULT_AGENT_PERSONA: AgentPersona;
export declare const UNKNOWN_AGENT_PERSONA_FALLBACK: AgentPersona;
export declare function resolveAgentPersona(value: unknown): AgentPersona;
export declare function parseAgentPersona(value: unknown, path: string): AgentPersona;
