import { query, type RouteDoc } from './openapi-route-helpers.js';

const candidateId = {
  name: 'candidateId',
  in: 'path',
  required: true,
  description: 'Onboarding credential candidate id.',
  schema: { type: 'string', format: 'uuid' },
};

export const onboardingOpenApiRouteDocs: RouteDoc[] = [
  {
    method: 'get',
    path: '/ui/api/onboarding/status',
    operationId: 'getBrowserOnboardingStatus',
    tag: 'Onboarding',
    summary: 'Read durable onboarding progress',
    description:
      'Returns server-authoritative onboarding progress and resume state.',
  },
  {
    method: 'post',
    path: '/ui/api/onboarding/model-candidates',
    operationId: 'stageBrowserOnboardingModelCandidate',
    tag: 'Onboarding',
    summary: 'Stage encrypted model credentials',
    description: 'Stages encrypted model credentials without activating them.',
    body: 'json',
    status: '201',
  },
  ...['check', 'verify', 'activate', 'cancel'].map(
    (action): RouteDoc => ({
      method: 'post',
      path: `/ui/api/onboarding/model-candidates/{candidateId}/${action}`,
      operationId: `${action}BrowserOnboardingModelCandidate`,
      tag: 'Onboarding',
      summary: `${action} a model credential candidate`,
      description: `${action} a staged model credential candidate.`,
      body: 'json',
      parameters: [candidateId],
    }),
  ),
  {
    method: 'post',
    path: '/ui/api/onboarding/provider-candidates',
    operationId: 'stageBrowserOnboardingProviderCandidate',
    tag: 'Onboarding',
    summary: 'Stage encrypted Slack credentials',
    description: 'Stages encrypted Slack credentials without activating them.',
  },
  ...['validate', 'activate', 'cancel'].map(
    (action): RouteDoc => ({
      method: 'post',
      path: `/ui/api/onboarding/provider-candidates/{candidateId}/${action}`,
      operationId: `${action}BrowserOnboardingProviderCandidate`,
      tag: 'Onboarding',
      summary: `${action} a Slack credential candidate`,
      description: `${action} a staged Slack credential candidate.`,
    }),
  ),
  {
    method: 'get',
    path: '/ui/api/onboarding/conversations',
    operationId: 'discoverBrowserOnboardingConversations',
    tag: 'Onboarding',
    summary: 'Discover Slack conversations for onboarding',
    description:
      'Discovers conversations through the activated onboarding account.',
  },
  {
    method: 'get',
    path: '/ui/api/onboarding/conversations/{conversationId}/members',
    operationId: 'listBrowserOnboardingConversationMembers',
    tag: 'Onboarding',
    summary: 'List eligible Slack conversation members',
    description:
      'Lists eligible human members in the selected Slack conversation.',
  },
  {
    method: 'post',
    path: '/ui/api/onboarding/assignment',
    operationId: 'bindBrowserOnboardingAssignment',
    tag: 'Onboarding',
    summary: 'Bind one conversation and one verified approver',
    description: 'Atomically binds the selected conversation and approver.',
  },
  {
    method: 'get',
    path: '/ui/api/onboarding/challenge',
    operationId: 'getBrowserOnboardingChallenge',
    tag: 'Onboarding',
    summary: 'Read the current correlated Slack challenge',
    description: 'Returns the current challenge and its server-derived state.',
  },
  {
    method: 'post',
    path: '/ui/api/onboarding/challenge',
    operationId: 'createBrowserOnboardingChallenge',
    tag: 'Onboarding',
    summary: 'Create or supersede a correlated Slack challenge',
    description: 'Creates a single-use challenge for the current deployment.',
  },
  {
    method: 'post',
    path: '/ui/api/onboarding/complete',
    operationId: 'completeBrowserOnboarding',
    tag: 'Onboarding',
    summary: 'Complete the current Ready onboarding deployment',
    description:
      'Marks onboarding complete only for the current Ready deployment.',
  },
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
