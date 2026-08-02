import type { Job, ConversationRoute } from '../../domain/types.js';
import type { JobVisibilityMetadata } from '../../application/jobs/job-visibility-metadata.js';
import type { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { ApiKeyRecord } from './auth.js';
import type { ControlRouteContext } from './handler-context.js';
export declare function nowIso(): IsoTimestamp;
export declare function makeAppGroup(input: {
    appId: string;
    conversationId: string;
    chatJid: string;
}): ConversationRoute;
export declare function canAccessApp(auth: ApiKeyRecord, appId: string | null | undefined): boolean;
export declare function resolveAppScopeAppId(auth: ApiKeyRecord, assertedAppId: string | null | undefined): string | null;
export declare function resolveJobAppSession(control: ReturnType<typeof getRuntimeControlRepository>, job: Job, appId: string): Promise<{
    sessionId: string;
    appId: string;
    conversationJid: string;
    workspaceKey: string;
    defaultResponseMode: import("../../adapters/storage/postgres/schema/control-plane-records.postgres.js").ControlResponseMode;
    defaultWebhookId: string | null;
} | undefined>;
export declare function mapManualJobToStored(job: Job, metadata: JobVisibilityMetadata, options?: {
    detail?: boolean;
    getDefaultModelConfig?: ControlRouteContext['getDefaultModelConfig'];
    getSelectedAgentHarness?: ControlRouteContext['getSelectedAgentHarness'];
}): Record<string, unknown>;
