import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ControlRouteContext } from '../handler-context.js';
export declare function handleSettingsRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, pathname: string): Promise<boolean>;
export declare function writeControlDesiredState(input: {
    res: ServerResponse;
    ctx: ControlRouteContext;
    key: {
        appId: string;
        kid: string;
    };
    body: unknown;
}): Promise<boolean>;
