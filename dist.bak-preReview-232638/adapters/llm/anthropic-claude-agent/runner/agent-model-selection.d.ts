import { type ModelCatalogEntry } from '../../../../shared/model-catalog.js';
export interface AgentModelValidationResult {
    message?: string;
}
export declare function requestedModelFromAgentInput(input: unknown): string | undefined;
export declare function unsupportedAgentConfigurationField(input: unknown): string | undefined;
export declare function validateAgentModelRequest(requestedModel: string | undefined, currentModel: ModelCatalogEntry | undefined): AgentModelValidationResult;
export declare function validateAgentToolInput(input: unknown, currentModel: ModelCatalogEntry | undefined): string | null;
