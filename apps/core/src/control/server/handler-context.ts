import type { IncomingMessage, ServerResponse } from 'node:http';

import type {
  RuntimeSettingsResponse,
  UpdateRuntimeSettingsRequest,
  UpdateRuntimeSettingsResponse,
} from '@myclaw/contracts';
import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import { authenticate, type ApiKeyRecord, type Scope } from './auth.js';
import { sendError } from './http.js';
import type { RateLimiter } from './rate-limit.js';

export type ControlServerState = {
  activeStreams: number;
  activeWaits: number;
  activeTriggerWaits: number;
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
  updateRuntimeSettings: (
    patch: UpdateRuntimeSettingsRequest,
  ) => UpdateRuntimeSettingsResponse;
};

export function authorizeControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  keys: ApiKeyRecord[],
  scopes: Scope[],
): ApiKeyRecord | null {
  const auth = authenticate(req, scopes, keys);
  if (!auth) {
    sendError(res, 401, 'UNAUTHORIZED', 'Missing or invalid API key');
    return null;
  }
  return auth;
}
