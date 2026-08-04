import type { IncomingMessage, ServerResponse } from 'node:http';
import { type ControlRouteContext } from '../handler-context.js';
export declare function handleWebhookRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, pathname: string): Promise<boolean>;
