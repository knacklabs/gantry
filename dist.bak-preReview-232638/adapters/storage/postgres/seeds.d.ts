import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from './schema/schema.js';
export declare const DEFAULT_APP_ID = "default";
export declare const DEFAULT_AGENT_ID = "agent:main_agent";
export declare const DEFAULT_AGENT_CONFIG_VERSION_ID = "config:agent:main_agent:1";
export declare const DEFAULT_LLM_PROFILE_ID = "llm:default";
export declare const DEFAULT_PERMISSION_POLICY_ID = "permission-policy:default";
export declare const DEFAULT_PERMISSION_RULE_ID = "permission-rule:default:approval-required";
export declare const DEFAULT_SANDBOX_PROFILE_ID = "sandbox-profile:local-dev";
export declare const DEFAULT_SKILL_CATALOG: readonly [{
    readonly id: "skill:memory";
    readonly name: "memory";
}, {
    readonly id: "skill:scheduler";
    readonly name: "scheduler";
}, {
    readonly id: "skill:browser";
    readonly name: "browser";
}];
export declare function seedDefaultRuntimeData(db: NodePgDatabase<typeof pgSchema>): Promise<void>;
export declare const DEFAULT_TOOL_CATALOG: readonly [{
    readonly id: "tool:Browser";
    readonly name: "Browser";
    readonly kind: "browser";
    readonly provider: "gantry";
    readonly providerToolName: undefined;
    readonly displayName: "Browser";
    readonly description: "Use the shared Gantry browser capability.";
    readonly category: "web";
    readonly risk: "medium";
    readonly inputSchema: undefined;
}, ...({
    readonly id: "tool:WebSearch" | "tool:WebRead" | "tool:FileSearch" | "tool:FileRead" | "tool:FileEdit" | "tool:FileWrite" | "tool:AgentDelegation";
    readonly name: "WebSearch" | "WebRead" | "FileSearch" | "FileRead" | "FileEdit" | "FileWrite" | "AgentDelegation";
    readonly kind: "host";
    readonly provider: "gantry";
    readonly providerToolName: undefined;
    readonly displayName: string;
    readonly description: string;
    readonly category: "agent" | "web" | "files" | "execution";
    readonly risk: "low" | "medium" | "high";
    readonly inputSchema: {
        format: "json-schema";
        schema: Record<string, unknown>;
    };
} | {
    readonly id: string;
    readonly name: string;
    readonly kind: "host";
    readonly provider: "gantry";
    readonly providerToolName: undefined;
    readonly displayName: string;
    readonly description: string;
    readonly category: "search" | "agent" | "admin" | "channel" | "web" | "files" | "execution" | "mcp";
    readonly risk: "low" | "medium" | "high";
    readonly inputSchema: undefined;
})[]];
