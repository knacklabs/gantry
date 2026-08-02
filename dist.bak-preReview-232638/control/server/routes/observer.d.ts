import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ControlRouteContext } from '../handler-context.js';
export declare function handleObserverRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, url: URL, pathname: string): Promise<boolean>;
