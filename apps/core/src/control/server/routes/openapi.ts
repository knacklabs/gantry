import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../http.js';
import { getGantryOpenApiDocument } from '../openapi.js';

const swaggerHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gantry Control API</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f7f7f7; }
      .swagger-ui .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        displayRequestDuration: true,
        persistAuthorization: true,
        tryItOutEnabled: true
      });
    </script>
  </body>
</html>`;

export async function handleOpenApiRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  if (pathname === '/openapi.json' || pathname === '/v1/openapi.json') {
    sendJson(res, 200, getGantryOpenApiDocument());
    return true;
  }

  if (
    pathname === '/docs' ||
    pathname === '/docs/' ||
    pathname === '/swagger' ||
    pathname === '/swagger/'
  ) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(swaggerHtml);
    return true;
  }

  return false;
}
