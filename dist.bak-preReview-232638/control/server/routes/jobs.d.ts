import type { IncomingMessage, ServerResponse } from 'node:http';
import { JobManagementService } from '../../../application/jobs/job-management-service.js';
import { type ControlRouteContext } from '../handler-context.js';
export declare function createJobManagementService(ctx?: ControlRouteContext): JobManagementService;
export declare function handleJobRoutes(req: IncomingMessage, res: ServerResponse, ctx: ControlRouteContext, url: URL, pathname: string): Promise<boolean>;
