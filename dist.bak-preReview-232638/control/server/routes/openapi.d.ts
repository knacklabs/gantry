import type { IncomingMessage, ServerResponse } from 'node:http';
export declare function handleOpenApiRoutes(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
