import { query, type RouteDoc } from './openapi-route-helpers.js';

export const onboardingOpenApiRouteDocs: RouteDoc[] = [
  {
    method: 'get',
    path: '/ui/api/onboarding/channel-manifest',
    operationId: 'getBrowserOnboardingChannelManifest',
    tag: 'Onboarding',
    summary: 'Read onboarding channel manifest',
    description:
      'Returns the supported provider setup manifest without credentials.',
    parameters: [
      query('providerId', 'Channel provider id.', { type: 'string' }),
      query('employeeName', 'Employee display name.', { type: 'string' }),
    ],
  },
];
