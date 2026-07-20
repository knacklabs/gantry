import fs from 'fs';
import { randomUUID } from 'node:crypto';

import {
  AGENT_TIMEOUT,
  DATA_DIR,
  IDLE_TIMEOUT,
  getCredentialBrokerRuntimeConfig,
  getEffectiveModelConfig,
  getRuntimeSettingsForConfig,
  getSelectedAgentHarness,
} from '../config/index.js';
import { resolveAgentAccessPolicy } from '../config/profiles.js';
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
  resolveEffectivePermissionMode,
  type PermissionMode,
} from '../shared/permission-mode.js';
import {
  resolveWorkspaceFolderPath,
  resolveWorkspaceIpcPath,
} from '../platform/workspace-folder.js';
import {
  ensureWorkspaceIpcLayout,
  getHostAgentRunnerDistDir,
} from './agent-spawn-layout.js';
import {
  AgentInput,
  type AgentOutput,
  HostRuntimeContext,
} from './agent-spawn-types.js';
import { resolveSpawnModel } from './agent-spawn-model-resolution.js';
import { compileSpawnSystemPrompt } from './agent-spawn-prompt.js';
import {
  getConfiguredModelProvidersForApp,
  getRuntimeFileArtifactStore,
} from '../adapters/storage/postgres/runtime-store.js';

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

export function getConfiguredAgentMaxRunTokens(
  agentFolder: string,
): number | undefined {
  return getRuntimeSettingsForConfig().agents?.[agentFolder]?.maxRunTokens;
}

export function createConfiguredRunTokenBudget(agentFolder: string) {
  let maxRunTokens: number | undefined;
  let settingsRead = false;
  const seenUsageEventIds = new Set<string>();
  const seenUsage = new WeakSet<object>();
  let observedTokens = 0;
  let failure: AgentOutput | undefined;
  return {
    get exceeded() {
      return failure !== undefined;
    },
    enforce(output: AgentOutput): AgentOutput {
      if (failure) return failure;
      if (!output.usage) return output;
      if (!settingsRead) {
        maxRunTokens = getConfiguredAgentMaxRunTokens(agentFolder);
        settingsRead = true;
      }
      const duplicate = output.usageEventId
        ? seenUsageEventIds.has(output.usageEventId)
        : seenUsage.has(output.usage);
      if (duplicate) return output;
      if (output.usageEventId) seenUsageEventIds.add(output.usageEventId);
      else seenUsage.add(output.usage);
      observedTokens += output.usage.inputTokens + output.usage.outputTokens;
      if (maxRunTokens === undefined || observedTokens <= maxRunTokens)
        return output;
      failure = {
        status: 'error',
        result: null,
        error: `Agent run token budget exceeded: max_run_tokens is ${maxRunTokens}; observed total is ${observedTokens} tokens.`,
      };
      return failure;
    },
  };
}

export function withControls(
  input: AgentInput,
  defaults?: {
    effort?: AgentInput['effort'];
    thinking?: AgentInput['configuredThinking'];
    maxOutputTokens?: number;
    toolRules?: AgentInput['toolRules'];
    permissionMode?: AgentInput['permissionMode'];
  },
  conversationPermissionMode?: AgentInput['permissionMode'],
): AgentInput & { permissionMode: PermissionMode } {
  const {
    toolRules: _untrustedToolRules,
    permissionMode: _untrustedPermissionMode,
    ...trustedInput
  } = input;
  const toolRules = defaults?.toolRules;
  return {
    ...trustedInput,
    effort: input.effort ?? defaults?.effort,
    configuredThinking: input.configuredThinking ?? defaults?.thinking,
    maxOutputTokens: input.maxOutputTokens ?? defaults?.maxOutputTokens,
    permissionMode: resolveEffectivePermissionMode(
      conversationPermissionMode,
      defaults?.permissionMode,
    ),
    ...(toolRules?.length ? { toolRules } : {}),
  };
}

export async function prepareInlineAgentHostContext(
  group: ConversationRoute,
  input: AgentInput,
) {
  const runtimeSettings = getRuntimeSettingsForConfig();
  const modelConfig = getEffectiveModelConfig(
    input.isScheduledJob ? undefined : group.agentConfig?.model,
    input.isScheduledJob
      ? input.jobModelUseKind || 'recurringJob'
      : 'interactive',
    group.folder,
  );
  const { resolvedModel } = await resolveSpawnModel({
    group,
    agentInput: input,
    appId: input.appId || 'default',
    modelConfig,
    agentHarness: getSelectedAgentHarness(group.folder),
    modelFamilyOrder: runtimeSettings.modelFamilies,
    listConfiguredProviders: getConfiguredModelProvidersForApp,
  });
  const compiledSystemPrompt = resolvedModel.ok
    ? await compileSpawnSystemPrompt({
        group,
        agentInput: input,
        appId: input.appId || 'default',
        accessPreset: resolveAgentAccessPolicy(
          runtimeSettings.agents?.[group.folder]?.accessPreset,
        ).preset,
        modelIdentity: {
          alias: resolvedModel.value.modelEntry.displayName,
          modelId: resolvedModel.value.runnerModel,
          provider: resolvedModel.value.modelEntry.modelRoute.label,
        },
        fileArtifactStore: () => getRuntimeFileArtifactStore(),
        measureAsync: async (_name, fn) => fn(),
      })
    : undefined;
  const effectiveInput = withControls(
    input,
    runtimeSettings.agents?.[group.folder],
    group.agentConfig?.permissionMode,
  );
  return {
    resolvedModel,
    compiledSystemPrompt,
    dataDir: DATA_DIR,
    defaultTimeoutMs: AGENT_TIMEOUT,
    idleTimeoutMs: IDLE_TIMEOUT,
    sandboxProvider: runtimeSettings.runtime.sandbox.provider,
    maxTurns: runtimeSettings.agents?.[group.folder]?.maxTurns,
    effort: effectiveInput.effort,
    configuredThinking: effectiveInput.configuredThinking,
    maxOutputTokens: effectiveInput.maxOutputTokens,
    permissionMode: effectiveInput.permissionMode,
    ...(effectiveInput.toolRules?.length
      ? { toolRules: effectiveInput.toolRules }
      : {}),
  };
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
  brokerAuthMode?: string;
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
    ...(injection.brokerAuthMode
      ? { brokerAuthMode: injection.brokerAuthMode }
      : {}),
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
