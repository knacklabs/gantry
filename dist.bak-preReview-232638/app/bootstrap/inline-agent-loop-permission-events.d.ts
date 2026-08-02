import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { PermissionApprovalRequest } from '../../domain/types.js';
export declare function publishInlinePermissionEvent(deps: {
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
}, request: PermissionApprovalRequest, eventType: (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES], payload: Record<string, unknown>): Promise<void>;
