import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeEvent } from '../../../domain/events/events.js';
import { type ControlRouteContext } from '../handler-context.js';
export declare function handleSessionRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, url: URL, pathname: string): Promise<boolean>;
declare function writeSseEvent(res: ServerResponse, event: RuntimeEvent, isClosed?: () => boolean): Promise<void>;
export declare const _testSessionRoutes: {
    writeSseEvent: typeof writeSseEvent;
};
export {};
