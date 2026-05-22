import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RuntimeSettingsResponse } from '@gantry/contracts';
import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import type { JobManagementServiceDeps } from '../../application/jobs/job-management-types.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ModelCatalogEntry,
  ModelProviderId,
  ModelWorkload,
} from '../../shared/model-catalog.js';
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

export type ControlModelDefaultSlot = {
  configuredAlias: string | null;
  effectiveAlias: string | null;
  source: string;
  workload: ModelWorkload;
  modelEntry: ModelCatalogEntry | null;
};

export type ControlModelDefaults = {
  defaults: {
    chat: ControlModelDefaultSlot;
    oneTime: ControlModelDefaultSlot;
    recurring: ControlModelDefaultSlot;
    memoryExtractor: ControlModelDefaultSlot;
    memoryDreaming: ControlModelDefaultSlot;
    memoryConsolidation: ControlModelDefaultSlot;
  };
};

export type ControlModelDefaultsPatchResult =
  | { ok: true }
  | { ok: false; message: string };

export type ControlProviderPreflightResult = {
  ok: boolean;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
};

export type ControlRouteContext = {
  app: RuntimeApp;
  runtimeHome: string;
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
  getModelDefaults: () => ControlModelDefaults;
  patchModelDefaults: (
    body: Record<string, unknown>,
  ) => ControlModelDefaultsPatchResult;
  preflightModelProvider: (
    provider: ModelProviderId,
  ) => Promise<ControlProviderPreflightResult>;
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
