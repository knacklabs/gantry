import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ControlRouteContext } from '../handler-context.js';
type FamilyProviderOptions = {
    configuredProviders?: ReadonlySet<string>;
    familyOrder?: Record<string, string[]>;
};
export declare function providersSelectedByPatch(body: Record<string, unknown>, defaults: ReturnType<ControlRouteContext['getModelDefaults']>, options?: FamilyProviderOptions): string[];
type ModelPreviewRouteResult = {
    ok: true;
    body: Record<string, unknown>;
} | {
    ok: false;
    status: number;
    code: string;
    message: string;
};
export declare function memoryModelPreview(ctx: ControlRouteContext, body: Record<string, unknown>): ModelPreviewRouteResult;
export declare function handleModelRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, pathname: string): Promise<boolean>;
export {};
