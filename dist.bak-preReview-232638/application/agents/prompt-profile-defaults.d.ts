import { type AgentRelationshipMode } from '../../shared/agent-relationship-mode.js';
export declare const AGENTS_FILENAME = "AGENTS.md";
export declare const SOUL_FILENAME = "SOUL.md";
export declare const promptProfileAgentIdForFolder: (agentFolder: string) => string;
export declare function defaultAgentsPromptMarkdown(agentName: string, relationshipMode?: AgentRelationshipMode, accessPreset?: 'full' | 'locked'): string;
export declare function defaultSoulPromptMarkdown(agentName: string, relationshipMode?: AgentRelationshipMode): string;
export declare function promptProfileAgentsPath(agentFolder: string): string;
export declare function promptProfileSoulPath(agentFolder: string): string;
export declare const PROFILE_FILE_NAMES: {
    readonly soul: "SOUL.md";
    readonly agents: "AGENTS.md";
};
