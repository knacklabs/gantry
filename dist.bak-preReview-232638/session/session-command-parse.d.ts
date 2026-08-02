import type { ThinkingOverride } from '../domain/types.js';
import type { PermissionMode } from '../shared/permission-mode.js';
export type SessionCommand = {
    kind: 'commands';
    raw: '/commands';
} | {
    kind: 'compact';
    raw: '/compact';
} | {
    kind: 'new';
    raw: '/new';
} | {
    kind: 'stop';
    raw: '/stop';
} | {
    kind: 'dream';
    raw: '/dream';
} | {
    kind: 'memory_status';
    raw: '/memory-status';
} | {
    kind: 'models_list';
    raw: '/models';
} | {
    kind: 'status';
    raw: '/status';
} | {
    kind: 'save_procedure';
    raw: string;
    title: string;
    body?: string;
} | {
    kind: 'model_show';
    raw: '/model';
} | {
    kind: 'model_why';
    raw: string;
    value: string;
} | {
    kind: 'model_set';
    raw: string;
    value: string;
} | {
    kind: 'model_default';
    raw: '/model default';
} | {
    kind: 'thinking_show';
    raw: '/thinking';
} | {
    kind: 'thinking_set';
    raw: string;
    value: ThinkingOverride;
} | {
    kind: 'thinking_default';
    raw: '/thinking default';
} | {
    kind: 'permissions_show';
    raw: '/permissions';
} | {
    kind: 'permissions_set';
    raw: string;
    value: PermissionMode;
} | {
    kind: 'permissions_default';
    raw: '/permissions default';
};
export declare function extractSessionCommand(content: string, triggerPattern: RegExp): SessionCommand | null;
/**
 * Check if a session command sender is authorized.
 * Allowed only for trusted/admin sender (is_from_me) or explicit sender allowlist membership.
 */
export declare function isSessionCommandAllowed(isFromMe: boolean, isSenderControlAllowlisted: boolean): boolean;
export interface AgentResult {
    status: 'success' | 'error';
    result?: string | object | null;
}
