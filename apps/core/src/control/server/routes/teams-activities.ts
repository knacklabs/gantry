import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlRouteContext } from '../handler-context.js';
import { sendError } from '../http.js';

export async function handleTeamsActivityRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  context: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  const match = /^\/v1\/providers\/teams\/([^/]+)\/activities$/.exec(pathname);
  if (!match) return false;
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    sendError(
      response,
      405,
      'METHOD_NOT_ALLOWED',
      'Use POST to deliver a Teams activity.',
    );
    return true;
  }
  if (!context.processTeamsActivity) {
    sendError(
      response,
      503,
      'TEAMS_UNAVAILABLE',
      'Teams inbound is unavailable. Send this endpoint to the live worker.',
    );
    return true;
  }
  await context.processTeamsActivity({
    providerAccountId: decodeURIComponent(match[1]!),
    request,
    response,
  });
  return true;
}
