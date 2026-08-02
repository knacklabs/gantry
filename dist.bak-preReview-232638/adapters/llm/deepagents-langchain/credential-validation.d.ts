import type { AgentExecutionCredentialProjection } from '../../../application/agent-execution/agent-execution-adapter.js';
import type { ModelCatalogEntry } from '../../../shared/model-catalog.js';
export declare function validateDeepAgentCredentialProjection(input: {
    entry?: ModelCatalogEntry;
    projection: AgentExecutionCredentialProjection;
}): void;
