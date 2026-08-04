import http from 'node:http';
import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import type { ProcessRole, ReadinessRoleRequirements } from './system-health.js';
import type { JobManagementServiceDeps } from '../../application/jobs/job-management-types.js';
import { canAccessApp, makeAppGroup } from './app-identity.js';
import { isValidControlId, parseControlApiKeys, parseControlApiKeysStrict } from './auth.js';
import type { ControlRouteContext } from './handler-context.js';
import { deliverWebhookDelivery, flushWebhookDeliveries } from './webhook-delivery.js';
export interface ControlServerHandle {
    close: () => Promise<void>;
}
declare function applyControlSocketMode(socketPath: string, server: Pick<http.Server, 'close'>): boolean;
declare function isControlClientDisconnectError(error: unknown): boolean;
export declare function startControlServer(input: {
    app: RuntimeApp;
    getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
    sendConversationIngressProjection?: ControlRouteContext['sendConversationIngressProjection'];
    addMessageReaction?: ControlRouteContext['addMessageReaction'];
    /**
     * Which control routes to mount. `'full'` (default) mounts every route, the
     * historical behaviour. `'ops'` mounts only operational + read-only diagnostic
     * routes for worker roles, 404ing all admin/mutation routes.
     */
    routeProfile?: 'full' | 'ops';
    /** Process role this server runs as; surfaced on /readyz, /metrics, /v1/health. */
    processRole?: ProcessRole;
    /** Whether this role runs live execution (live readiness + live gauges). */
    liveExecution?: boolean;
    /** Whether durable live-turn admission is enabled in runtime settings. */
    liveTurnsEnabled?: boolean;
    /** Role-specific readiness checks that apply (derived by the runtime caller). */
    roleReadinessRequirements?: ReadinessRoleRequirements;
    /** Runtime accessors injected from the runtime layer (DI; no cross-layer import here). */
    currentWorkerInstanceId?: () => string | null;
    isSchedulerReady?: () => boolean;
    oldestWaitingLiveAdmissionSeconds?: () => number;
    liveCapacityLimit?: () => number;
    /** Lifecycle-owned settings that are actually active in this process. */
    getEffectiveRuntimeSettings?: ControlRouteContext['getEffectiveRuntimeSettings'];
    getEffectiveMemoryState?: ControlRouteContext['getEffectiveMemoryState'];
    agentSettings?: ControlRouteContext['agentSettings'];
    settingsImport?: ControlRouteContext['settingsImport'];
    resolveObserverStatus?: ControlRouteContext['resolveObserverStatus'];
}): ControlServerHandle;
declare function resolveControlHost(): string;
export declare const _testControlServer: {
    parseControlApiKeys: typeof parseControlApiKeys;
    parseControlApiKeysStrict: typeof parseControlApiKeysStrict;
    canAccessApp: typeof canAccessApp;
    applyControlSocketMode: typeof applyControlSocketMode;
    isControlClientDisconnectError: typeof isControlClientDisconnectError;
    isValidControlId: typeof isValidControlId;
    isPrivateAddress: typeof import("../../domain/network/public-address-policy.js").isPrivateNetworkAddress;
    makeAppGroup: typeof makeAppGroup;
    resolveControlHost: typeof resolveControlHost;
    deliverWebhookDelivery: typeof deliverWebhookDelivery;
    flushWebhookDeliveries: typeof flushWebhookDeliveries;
};
export {};
