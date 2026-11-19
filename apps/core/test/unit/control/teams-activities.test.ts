import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { handleTeamsActivityRoutes } from '@core/control/server/routes/teams-activities.js';
import type { ControlRouteContext } from '@core/control/server/handler-context.js';

describe('Teams activity control route', () => {
  it('forwards the path account and raw Node streams without consuming the body', async () => {
    const request = new IncomingMessage(new Socket());
    request.method = 'POST';
    const response = new ServerResponse(request);
    const processTeamsActivity = vi.fn(async () => {});
    const handled = await handleTeamsActivityRoutes(
      request,
      response,
      { processTeamsActivity } as unknown as ControlRouteContext,
      '/v1/providers/teams/shared%20alias/activities',
    );
    expect(handled).toBe(true);
    expect(processTeamsActivity).toHaveBeenCalledWith({
      providerAccountId: 'shared alias',
      request,
      response,
    });
    expect(request.readableFlowing).toBeNull();
  });

  it('refuses an outbound-only process without reading the request', async () => {
    const request = new IncomingMessage(new Socket());
    request.method = 'POST';
    const response = new ServerResponse(request);
    const end = vi.spyOn(response, 'end');
    await handleTeamsActivityRoutes(
      request,
      response,
      {} as ControlRouteContext,
      '/v1/providers/teams/outbound/activities',
    );
    expect(response.statusCode).toBe(503);
    expect(request.readableFlowing).toBeNull();
    expect(end).toHaveBeenCalled();
  });
});
