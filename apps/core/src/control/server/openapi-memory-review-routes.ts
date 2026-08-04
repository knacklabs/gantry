import { doc, query, type RouteDoc } from './openapi-route-helpers.js';

export const memoryReviewRouteDocs: RouteDoc[] = [
  doc(
    'get',
    '/v1/memory/reviews',
    'listMemoryReviews',
    'Memory',
    'List pending memory reviews',
    'Lists the pending memory-review queue for one subject as a bounded, immutable-snapshot preview.',
    ['memory:read'],
    {
      parameters: [
        query('appId', 'App id. Defaults to API key app.'),
        { ...query('agentId', 'Agent id.'), required: true },
        {
          ...query('subjectType', 'Canonical memory subject type.', {
            type: 'string',
            enum: ['user', 'group', 'channel', 'common'],
          }),
          required: true,
        },
        {
          ...query('subjectId', 'Canonical memory subject id.'),
          required: true,
        },
        query('limit', 'Maximum number of reviews to return.', {
          type: 'integer',
          minimum: 1,
        }),
        query('offset', 'Pending-review page offset.', {
          type: 'integer',
          minimum: 0,
        }),
      ],
    },
  ),
  doc(
    'get',
    '/v1/memory/reviews/{reviewId}',
    'getMemoryReview',
    'Memory',
    'Get memory review detail',
    'Returns the full immutable snapshot for one pending review: both claims, the proposed canonical value, and every cited evidence row with untruncated text and source uri.',
    ['memory:read'],
    {
      parameters: [
        {
          name: 'reviewId',
          in: 'path',
          required: true,
          description: 'Memory review id.',
          schema: { type: 'string' },
        },
        query('appId', 'App id. Defaults to API key app.'),
        { ...query('agentId', 'Agent id.'), required: true },
        {
          ...query('subjectType', 'Canonical memory subject type.', {
            type: 'string',
            enum: ['user', 'group', 'channel', 'common'],
          }),
          required: true,
        },
        {
          ...query('subjectId', 'Canonical memory subject id.'),
          required: true,
        },
      ],
    },
  ),
  doc(
    'post',
    '/v1/memory/reviews/{reviewId}/decision',
    'decideMemoryReview',
    'Memory',
    'Decide a memory review',
    'Applies a reviewer decision (approve, reject, or edit_approve) to one pending review. The reviewer identity is derived from the authenticated API key; the decision source is recorded as the control API.',
    ['memory:admin'],
    {
      body: 'json',
      conflict: true,
      parameters: [
        {
          name: 'reviewId',
          in: 'path',
          required: true,
          description: 'Memory review id.',
          schema: { type: 'string' },
        },
        query('appId', 'App id. Defaults to API key app.'),
        { ...query('agentId', 'Agent id.'), required: true },
        {
          ...query('subjectType', 'Canonical memory subject type.', {
            type: 'string',
            enum: ['user', 'group', 'channel', 'common'],
          }),
          required: true,
        },
        {
          ...query('subjectId', 'Canonical memory subject id.'),
          required: true,
        },
      ],
    },
  ),
];
