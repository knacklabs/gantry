import { PROMPT_PROFILE_VIRTUAL_SCOPE } from '../../domain/file-artifacts/protected-virtual-path.js';
import type { FileArtifactStore } from '../../domain/ports/file-artifact-store.js';
import { type AgentPersona } from '../../shared/agent-persona.js';
import { type AgentRelationshipMode } from '../../shared/agent-relationship-mode.js';
import { type CapabilityCatalogRenderDiagnostics } from './agent-prompt-capability-guidance.js';
import type { AgentPromptCapabilityCatalog } from './agent-prompt-capability-catalog.js';
export { defaultAgentsPromptMarkdown, defaultSoulPromptMarkdown, PROFILE_FILE_NAMES, promptProfileAgentIdForFolder, promptProfileAgentsPath, promptProfileSoulPath, } from './prompt-profile-defaults.js';
type PromptSectionName = 'RUNTIME_RULES' | 'PERSONA' | 'SOUL' | 'CAPABILITY_GUIDANCE' | 'OPERATING_GUIDANCE' | 'AGENT_INSTRUCTIONS';
export declare const DEFAULT_PROMPT_SECTION_BUDGETS: Readonly<Record<PromptSectionName, number>>;
export declare const DEFAULT_PROMPT_TOTAL_BUDGET = 26000;
export type PromptAccessPreset = 'full' | 'locked';
export declare function capabilityGuidancePrompt(catalog: AgentPromptCapabilityCatalog | undefined, accessPreset: PromptAccessPreset, budget?: number, mcpInventoryToolsMounted?: boolean): string;
export declare const OPERATING_GUIDANCE_BLOCK: string;
export declare const LOCKED_OPERATING_GUIDANCE_BLOCK: string;
export interface PromptModelIdentity {
    alias: string;
    modelId: string;
    provider: string;
}
export interface PromptRuntimeContext {
    channelContextLine?: string;
    workspacePath?: string;
    job?: {
        id?: string;
        name?: string;
    };
}
type ChannelPromptPresentationRenderer = (chatJid: string | undefined, conversationKind: 'dm' | 'channel' | undefined) => string | undefined;
export declare function registerChannelPromptPresentationRenderer(renderer: ChannelPromptPresentationRenderer): void;
export declare function renderChannelPromptPresentationLine(chatJid: string | undefined, conversationKind: 'dm' | 'channel' | undefined): string | undefined;
export interface CompilePromptProfileOptions {
    agentFolder: string;
    persona?: AgentPersona;
    appId?: string;
    agentId?: string;
    accessPreset?: PromptAccessPreset;
    capabilityCatalog?: AgentPromptCapabilityCatalog;
    mcpInventoryToolsMounted?: boolean;
    modelIdentity?: PromptModelIdentity;
    runtimeContext?: PromptRuntimeContext;
}
export interface ProfileMirrorInput {
    agentFolder: string;
    fileName: string;
    content: string;
}
export interface PromptProfileServiceOptions {
    fileArtifactStore?: () => FileArtifactStore | undefined;
    appId?: string;
    sectionBudgets?: Partial<Record<PromptSectionName, number>>;
    totalBudget?: number;
    onCapabilityCatalogRendered?: (diagnostics: CapabilityCatalogRenderDiagnostics) => void;
    mirrorProfileFile?: (input: ProfileMirrorInput) => void | Promise<void>;
    mirrorFileExists?: (input: {
        agentFolder: string;
        fileName: string;
    }) => boolean | Promise<boolean>;
}
export declare class PromptProfileService {
    private readonly fileArtifactStore;
    private readonly appId;
    private readonly sectionBudgets;
    private readonly totalBudget;
    private readonly onCapabilityCatalogRendered?;
    private readonly mirrorProfileFile?;
    private readonly mirrorFileExists?;
    constructor(options?: PromptProfileServiceOptions);
    ensureAgentDefaults(options: {
        agentFolder: string;
        agentName: string;
        appId?: string;
        agentId?: string;
        relationshipMode?: AgentRelationshipMode;
        accessPreset?: PromptAccessPreset;
        groupContext?: string;
        soul?: string;
    }): Promise<void>;
    compileSystemPrompt(options: CompilePromptProfileOptions): Promise<string>;
    private writeDefaultIfMissing;
    private reseedMirrorIfMissing;
    private readSoulSection;
    private readAgentInstructionsSection;
    private readPromptArtifact;
    private composeWithinTotalBudget;
}
export { PROMPT_PROFILE_VIRTUAL_SCOPE };
