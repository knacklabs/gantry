import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ControlRouteContext } from '../handler-context.js';
export declare function handleLlmRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, pathname: string): Promise<boolean>;
export declare function getLlmConcurrencyAdmissionSnapshotForTest(): {
    globalInFlight: number;
    perAppKeyInFlight: Record<string, number>;
};
