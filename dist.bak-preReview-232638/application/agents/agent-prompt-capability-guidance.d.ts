import { type AgentPromptCapabilityCatalog } from './agent-prompt-capability-catalog.js';
export interface CapabilityCatalogRenderDiagnostics {
    rendered: CatalogSectionCounts;
    omitted: CatalogSectionCounts;
}
interface CatalogSectionCounts {
    readyActions: number;
    installedSkills: number;
    connectedMcpSources: number;
}
export declare function renderCapabilityGuidancePrompt(input: {
    catalog: AgentPromptCapabilityCatalog | undefined;
    accessPreset: 'full' | 'locked';
    mcpInventoryToolsMounted: boolean;
    budget: number;
}): {
    prompt: string;
    diagnostics: CapabilityCatalogRenderDiagnostics;
};
export {};
