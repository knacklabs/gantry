import fs from 'fs';
import { randomUUID } from 'node:crypto';

import { getCredentialBrokerRuntimeConfig } from '../config/index.js';
import { getAgentCredentialInjection } from '../application/credentials/agent-credential-service.js';
import { ConversationRoute } from '../domain/types.js';
import type { AppId } from '../domain/app/app.js';
import type { AgentId } from '../domain/agent/agent.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../domain/conversation/conversation.js';
import type { AgentRunId } from '../domain/events/events.js';
import type { JobId } from '../domain/jobs/jobs.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type {
  AgentCredentialPurpose,
  AgentCredentialInjection,
  CredentialBrokerProfile,
} from '../domain/models/credentials.js';
import type { ModelRouteId } from '../shared/model-catalog.js';
import {
  resolveWorkspaceFolderPath,
  resolveWorkspaceIpcPath,
} from '../platform/workspace-folder.js';
import {
  ensureWorkspaceIpcLayout,
  getHostAgentRunnerDistDir,
} from './agent-spawn-layout.js';
import { AgentInput, HostRuntimeContext } from './agent-spawn-types.js';

export interface HostRuntimeCredentialEnvOptions {
  purpose?: AgentCredentialPurpose;
  appId?: AppId;
  agentId?: AgentId;
  runId?: AgentRunId;
  jobId?: JobId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  modelRouteId?: ModelRouteId;
  runContext?: Pick<
    AgentInput,
    'appId' | 'agentId' | 'runId' | 'jobId' | 'chatJid' | 'threadId'
  >;
}

export async function getHostRuntimeCredentialEnv(
  agentIdentifier?: string,
  broker?: AgentCredentialBroker,
  options: HostRuntimeCredentialEnvOptions = {},
): Promise<{
  env: Record<string, string>;
  credentialProviders: NonNullable<
    AgentCredentialInjection['credentialProviders']
  >;
  proxy?: AgentCredentialInjection['proxy'];
  brokerApplied: boolean;
  brokerProfile: CredentialBrokerProfile;
  revoke?: () => Promise<void>;
}> {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const purpose = options.purpose ?? 'model_runtime';
  const runId =
    options.runId ??
    (options.runContext?.runId as AgentRunId | undefined) ??
    (`credential-run:${randomUUID()}` as AgentRunId);
  const bindingOptions = {
    purpose,
    appId: options.appId ?? (options.runContext?.appId as never),
    agentId: options.agentId ?? (options.runContext?.agentId as never),
    runId,
    jobId: options.jobId ?? (options.runContext?.jobId as never),
    conversationId:
      options.conversationId ?? (options.runContext?.chatJid as never),
    threadId: options.threadId ?? (options.runContext?.threadId as never),
    modelRouteId: options.modelRouteId,
  };
  const injection =
    brokerConfig.mode === 'gantry'
      ? await getAgentCredentialInjection({
          mode: 'gantry',
          ...bindingOptions,
          agentIdentifier,
          broker: requireGantryBroker(broker),
        })
      : await getAgentCredentialInjection({
          mode: 'none',
          purpose,
          agentIdentifier,
        });

  return {
    env: injection.env,
    credentialProviders: injection.credentialProviders ?? {},
    ...(injection.proxy ? { proxy: injection.proxy } : {}),
    brokerApplied: injection.applied,
    brokerProfile: injection.brokerProfile,
    ...(brokerConfig.mode === 'gantry' && broker?.revokeInjection
      ? {
          revoke: () =>
            broker.revokeInjection?.({
              binding: {
                profile: 'gantry',
                ...bindingOptions,
                ...(agentIdentifier ? { agentIdentifier } : {}),
              },
            }) ?? Promise.resolve(),
        }
      : {}),
  };
}

function requireGantryBroker(
  broker: AgentCredentialBroker | undefined,
): AgentCredentialBroker {
  if (!broker) {
    throw new Error(
      'Gantry Model Gateway is enabled but no model credential broker was provided.',
    );
  }
  return broker;
}

export function prepareHostRuntimeContext(
  group: ConversationRoute,
): HostRuntimeContext {
  const groupDir = resolveWorkspaceFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const runnerDistDir = getHostAgentRunnerDistDir();

  const workspaceIpcDir = resolveWorkspaceIpcPath(group.folder);
  ensureWorkspaceIpcLayout(workspaceIpcDir);

  return {
    groupDir,
    workspaceIpcDir,
    runnerDistDir,
  };
}
