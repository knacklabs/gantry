import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RuntimeSettingsResponse } from '@myclaw/contracts';
import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import type { JobManagementServiceDeps } from '../../application/jobs/job-management-types.js';
import type { AppId } from '../../domain/app/app.js';
import { authenticate, type ApiKeyRecord, type Scope } from './auth.js';
import { sendError } from './http.js';
import type { RateLimiter } from './rate-limit.js';

export type ControlServerState = {
  activeStreams: number;
  activeWaits: number;
  activeTriggerWaits: number;
};

export type ControlDefaultModelConfig = {
  model?: string;
  source: string;
};

export type ControlRouteContext = {
  app: RuntimeApp;
  keys: ApiKeyRecord[];
  socketPath: string;
  port: number;
  maxConcurrentStreams: number;
  maxConcurrentWaits: number;
  maxConcurrentTriggerWaits: number;
  state: ControlServerState;
  triggerRateLimiter: RateLimiter;
  getRuntimeSettings: () => RuntimeSettingsResponse['settings'];
  getDefaultModelConfig: (
    kind?: 'interactive' | 'oneTimeJob' | 'recurringJob',
    agentFolder?: string,
  ) => ControlDefaultModelConfig;
  getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
  syncSettingsFromProjection: (appId: AppId) => Promise<void>;
};

export function authorizeControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  keys: ApiKeyRecord[],
  scopes: Scope[],
): ApiKeyRecord | null {
  const auth = authenticate(req, scopes, keys);
  if (auth.status === 'authenticated') {
    return auth.key;
  }
  if (auth.status === 'forbidden') {
    sendError(
      res,
      403,
      'FORBIDDEN',
      `API key is missing required scope ${auth.missingScopes[0]}`,
    );
    return null;
  }
  if (auth.status === 'missing') {
    sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
    return null;
  }
  sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
  return null;
}
