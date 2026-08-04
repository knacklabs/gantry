export declare const RELATIONSHIP_MODES: readonly ["personal", "organization"];
export type AgentRelationshipMode = (typeof RELATIONSHIP_MODES)[number];
export declare const DEFAULT_RELATIONSHIP_MODE: AgentRelationshipMode;
export declare function resolveAgentRelationshipMode(value: unknown): AgentRelationshipMode;
export declare function parseAgentRelationshipMode(value: unknown, path: string): AgentRelationshipMode;
