import type { ControlRouteContext } from '../handler-context.js';
export type AgentModelPreviewResult = {
    ok: true;
    body: Record<string, unknown>;
} | {
    ok: false;
    status: number;
    code: string;
    message: string;
};
export declare function agentModelPreview(ctx: ControlRouteContext, body: Record<string, unknown>): AgentModelPreviewResult;
