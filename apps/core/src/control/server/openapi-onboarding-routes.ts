import { doc, ids, type RouteDoc } from './openapi-route-helpers.js';

const readAuth = {
  role: 'administrator' as const,
  mutation: false,
  recentReauthentication: false,
};
const writeAuth = {
  role: 'administrator' as const,
  mutation: true,
  recentReauthentication: true,
};
const idempotencyKey = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description: 'Stable key required for explicit setup retries.',
  schema: { type: 'string', minLength: 1 },
};

export const onboardingOpenApiRouteDocs: RouteDoc[] = [
  doc(
    'get',
    '/ui/api/onboarding/status',
    'getBrowserOnboardingStatus',
    'Onboarding',
    'Read onboarding status',
    'Returns the secret-free resumable first-agent onboarding projection.',
    undefined,
    { browserAuth: readAuth },
  ),
  doc(
    'get',
    '/ui/api/onboarding/channel-manifest',
    'getBrowserOnboardingChannelManifest',
    'Onboarding',
    'Read onboarding channel manifest',
    'Returns the supported provider setup manifest without credentials.',
    undefined,
    { browserAuth: readAuth },
  ),
  doc(
    'post',
    '/ui/api/onboarding/setups',
    'createBrowserOnboardingSetup',
    'Onboarding',
    'Create or resume onboarding setup',
    'Atomically creates one resumable first-agent setup. Explicit retries must reuse Idempotency-Key.',
    undefined,
    {
      additionalSuccessStatuses: ['200'],
      body: 'json',
      conflict: true,
      parameters: [idempotencyKey],
      status: '201',
      browserAuth: writeAuth,
    },
  ),
  doc(
    'post',
    '/ui/api/onboarding/verifications',
    'createBrowserOnboardingVerification',
    'Onboarding',
    'Create onboarding verification challenge',
    'Creates an expiring challenge bound to setup, account, conversation, and canonical thread.',
    undefined,
    { body: 'json', conflict: true, status: '201', browserAuth: writeAuth },
  ),
  doc(
    'get',
    '/ui/api/onboarding/verifications/{verificationId}',
    'getBrowserOnboardingVerification',
    'Onboarding',
    'Read onboarding verification',
    'Returns secret-free correlation and projection status.',
    undefined,
    { browserAuth: readAuth, parameters: [ids.onboardingVerification] },
  ),
  doc(
    'post',
    '/ui/api/onboarding/verifications/{verificationId}/project',
    'projectBrowserOnboardingVerification',
    'Onboarding',
    'Project a satisfied onboarding verification',
    'Explicitly retries desired-state projection without replaying challenge satisfaction.',
    undefined,
    {
      body: 'none',
      conflict: true,
      browserAuth: writeAuth,
      parameters: [ids.onboardingVerification],
    },
  ),
];
