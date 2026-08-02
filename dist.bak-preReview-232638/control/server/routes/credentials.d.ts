import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ControlRouteContext } from '../handler-context.js';
export declare function handleCredentialRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, pathname: string): Promise<boolean>;
