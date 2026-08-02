import type { AppId } from '../app/app.js';
import type { ToolCatalogRepository } from '../ports/repositories.js';
import type { ToolCatalogItem } from './tools.js';
import { type SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
export declare function ensureAgentToolCatalogItem(input: {
    repository: ToolCatalogRepository;
    appId: AppId;
    reference: string;
    now: string;
    description?: string;
    adapterRef?: string;
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Promise<ToolCatalogItem>;
export declare function resolveAgentToolReference(input: {
    repository: ToolCatalogRepository;
    appId: AppId;
    reference: string;
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): Promise<{
    tool?: ToolCatalogItem;
    error?: string;
}>;
