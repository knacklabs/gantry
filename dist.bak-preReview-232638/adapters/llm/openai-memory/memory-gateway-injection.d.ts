import type { AgentCredentialInjection } from '../../../domain/models/credentials.js';
import type { AgentCredentialPurpose } from '../../../domain/models/credentials.js';
import type { AgentRunId } from '../../../domain/events/events.js';
import type { AppId } from '../../../domain/app/app.js';
import type { ModelRouteId } from '../../../shared/model-catalog.js';
export declare function hasGatewayMemoryAccess(): boolean;
export interface GatewayMemoryInjection {
    injection: AgentCredentialInjection;
    revoke: () => Promise<void>;
}
export declare function resolveGatewayMemoryInjection(input: {
    appId: AppId;
    modelRouteId: ModelRouteId;
    runId: AgentRunId;
    purpose?: Extract<AgentCredentialPurpose, 'model_runtime' | 'model_batch'>;
    modelBatchRequestCount?: number;
    modelBatchId?: string;
}): Promise<GatewayMemoryInjection>;
