export declare const REQUEST_TOOL_ENABLE_SCOPE_GUIDANCE: string;
export declare const SOURCE_INVENTORY_AUTHORITY_GUIDANCE = "Sources only provide inventory and setup metadata. Durable authority is the reviewed action capability granted to the agent.";
export declare const UNREVIEWED_DISCOVERY_GUIDANCE = "CLI help, MCP tool lists, skill text, and adapter discovery can guide review, but the agent should use the reviewed action capability as the public contract.";
export declare const NO_REVIEWED_CAPABILITY_GUIDANCE: string;
export declare const PROACTIVE_RECOMMENDATION_GUIDANCE: string;
export declare function renderDefaultCapabilityRules(options?: {
    includeSettingsTools?: boolean;
}): string;
