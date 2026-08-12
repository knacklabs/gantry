import { doc, ids, query, type RouteDoc } from './openapi-route-helpers.js';

export const activityOpenApiRouteDocs: RouteDoc[] = [
  doc(
    'get',
    '/v1/activity',
    'listActivity',
    'Sessions',
    'List recent activity',
    'Returns the newest 50 app-owned agent runs in stable order using a safe activity projection.',
    ['sessions:read'],
  ),
  doc(
    'get',
    '/v1/activity/{runId}',
    'getActivity',
    'Sessions',
    'Get activity detail',
    'Returns one app-owned run and at most 100 safely projected tasks after verifying run ownership.',
    ['sessions:read'],
    { parameters: [ids.run] },
  ),
  doc(
    'get',
    '/v1/activity/{runId}/events',
    'listOrStreamActivityEvents',
    'Sessions',
    'List or stream activity invalidations',
    'Replays or streams only event id, type, and creation time for an app-owned run.',
    ['sessions:read'],
    {
      parameters: [
        ids.run,
        query('afterEventId', 'Resume after this durable event id.', {
          type: 'integer',
          minimum: 0,
        }),
      ],
    },
  ),
];
