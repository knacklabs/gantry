import type { IncomingMessage, ServerResponse } from 'node:http';

import type { RuntimeSettingsResponse } from '@gantry/contracts';
import type { RuntimeApp } from '../../app/bootstrap/runtime-app.js';
import type {
  ProcessRole,
  ReadinessRoleRequirements,
} from './system-health.js';
import type { JobManagementServiceDeps } from '../../application/jobs/job-management-types.js';
import type { ControlPlaneStorageSettings } from '../../application/control-plane/control-plane-storage-model.js';
import type { RuntimeCredentialBrokerSettings } from '../../config/settings/runtime-settings-types.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  ModelCatalogEntry,
  ModelWorkload,
} from '../../shared/model-catalog.js';
import type { AgentHarness } from '../../shared/agent-engine.js';
import type { AgentRuntime } from '../../shared/agent-runtime.js';
import type { EgressSettings } from '../../shared/egress-policy.js';
import { authenticate, type ApiKeyRecord, type Scope } from './auth.js';
import { sendError } from './http.js';
import type { RateLimiter } from './rate-limit.js';

type InternalRuntimeSettings = ControlPlaneStorageSettings & {
  modelFamilies?: Record<string, string[]>;
  credentialBroker?: RuntimeCredentialBrokerSettings;
};

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

export type ControlModelProviderPreflightResult = {
  ok: boolean;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
};

export type ControlRouteContext = {
  app: RuntimeApp;
  runtimeHome: string;
  keys: ApiKeyRecord[];
  /** Process role this server runs as; drives role-aware readiness + metrics. */
  processRole: ProcessRole;
  /** Whether this process role runs live execution (live readiness + gauges). */
  liveExecution: boolean;
  /** Whether durable live-turn admission is enabled in runtime settings. */
  liveTurnsEnabled?: boolean;
  /** Role-specific readiness checks that apply (derived from the role). */
  roleReadinessRequirements: ReadinessRoleRequirements;
  /**
   * Runtime accessors injected from the runtime layer so the control adapter
   * stays free of jobs/app cross-layer imports (existing DI pattern, like
   * getBrowserStatus). All optional with safe defaults for tests.
   */
  currentWorkerInstanceId?: () => string | null;
  isSchedulerReady?: () => boolean;
  oldestWaitingLiveAdmissionSeconds?: () => number;
  liveCapacityLimit?: () => number;
  socketPath: string;
  port: number;
  maxConcurrentStreams: number;
  maxConcurrentWaits: number;
  maxConcurrentTriggerWaits: number;
  state: ControlServerState;
  triggerRateLimiter: RateLimiter;
  getRuntimeSettings: () => RuntimeSettingsResponse['settings'];
  getInternalRuntimeSettings: () => InternalRuntimeSettings;
  getEgressSettings?: () => EgressSettings;
  getDefaultModelConfig: (
    kind?: 'interactive' | 'oneTimeJob' | 'recurringJob',
    agentFolder?: string,
  ) => ControlDefaultModelConfig;
  getModelDefaults: () => ControlModelDefaults;
  patchModelDefaults: (
    body: Record<string, unknown>,
    appId?: AppId,
    createdBy?: string,
    options?: {
      getConfiguredModelProviderIds?: () => Promise<ReadonlySet<string>>;
    },
  ) => Promise<ControlModelDefaultsPatchResult>;
  preflightModelProvider: (
    providerId: string,
    appId?: AppId,
    chatAlias?: string,
  ) => Promise<ControlModelProviderPreflightResult>;
  getActiveModelCredentialProviderIds: (appId: AppId) => Promise<string[]>;
  countPendingAccessRequests: (appId: AppId) => Promise<number>;
  listControlPlaneJobs: (appId: AppId) => Promise<
    Array<{
      id: string;
      status?: string;
      workspace_key?: string | null;
    }>
  >;
  sendConversationIngressProjection?: (input: {
    conversationJid: string;
    threadId: string | null;
    providerAccountId: string;
    text: string;
  }) => Promise<void>;
  addMessageReaction?: (
    jid: string,
    messageRef: string,
    emoji: string,
    options?: { providerAccountId?: string },
  ) => Promise<void>;
  getBrowserStatus?: JobManagementServiceDeps['getBrowserStatus'];
  syncSettingsFromProjection: (appId: AppId) => Promise<void>;
  getSelectedAgentHarness: (agentFolder?: string) => AgentHarness;
  getConfiguredAgentRuntime?: (
    agentFolder?: string,
  ) => AgentRuntime | undefined;
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
