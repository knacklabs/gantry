import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import type {
  AgentExecutionAdapter,
  AgentExecutionAdapterPrepareInput,
  AgentExecutionProviderId,
  PreparedAgentExecution,
} from '../../../application/agent-execution/agent-execution-adapter.js';
import { projectDeepAgentModelCredentialEnv } from './model-credential-env.js';
import { validateDeepAgentCredentialProjection } from './credential-validation.js';
import { isMissingDeepAgentSessionError } from './runner/session-store.js';
import { ensureDeepAgentsCheckpointSchema } from './checkpoint-setup.js';
import { resolveDeepAgentSkillProjection } from './skill-projection.js';
import { resolveDeepAgentsPromptCache } from './prompt-cache.js';
import type { OpenRouterProviderRouting } from '../../../shared/model-catalog-provider-metadata.js';

const GANTRY_DEEPAGENTS_MODEL_ID_ENV = 'GANTRY_DEEPAGENTS_MODEL_ID';
const GANTRY_DEEPAGENTS_MODEL_PROVIDER_ENV = 'GANTRY_DEEPAGENTS_MODEL_PROVIDER';
const GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL_ENV =
  'GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL';
const GANTRY_DEEPAGENTS_PROMPT_CACHE_KEY_ENV =
  'GANTRY_DEEPAGENTS_PROMPT_CACHE_KEY';
// Curated context window for empty-profile models (see model-catalog.ts). The
// runner passes it as the LangChain model profile's `maxInputTokens` so
// DeepAgents summarizes at 85% of the real window and context-usage reports a
// correct %. Omitted for ids with a real library profile (gpt-5.5/gpt-5.4) so
// the runner leaves that profile untouched.
const GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS_ENV =
  'GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS';
const GANTRY_DEEPAGENTS_OPENROUTER_PROVIDER_ROUTING_ENV =
  'GANTRY_DEEPAGENTS_OPENROUTER_PROVIDER_ROUTING';

function openRouterProviderRoutingEnv(
  routing: OpenRouterProviderRouting | undefined,
): string | undefined {
  if (!routing) return undefined;
  return JSON.stringify({
    ...(routing.only ? { only: routing.only } : {}),
    ...(routing.ignore ? { ignore: routing.ignore } : {}),
    ...(routing.order ? { order: routing.order } : {}),
    ...(routing.allowFallbacks !== undefined
      ? { allow_fallbacks: routing.allowFallbacks }
      : {}),
    ...(routing.requireParameters !== undefined
      ? { require_parameters: routing.requireParameters }
      : {}),
    ...(routing.dataCollection !== undefined
      ? { data_collection: routing.dataCollection }
      : {}),
    ...(routing.zdr !== undefined ? { zdr: routing.zdr } : {}),
    ...(routing.enforceDistillableText !== undefined
      ? { enforce_distillable_text: routing.enforceDistillableText }
      : {}),
    ...(routing.quantizations ? { quantizations: routing.quantizations } : {}),
    ...(routing.sort ? { sort: routing.sort } : {}),
  });
}

export function deepAgentsCheckpointSchema(storageSchema: string): string {
  const suffix = '_deepagents';
  const maxBaseLength = 63 - suffix.length;
  const base = storageSchema.slice(0, maxBaseLength);
  return `${base}${suffix}`;
}

export class DeepAgentsLangChainExecutionAdapter implements AgentExecutionAdapter {
  readonly id = 'deepagents:langchain' as AgentExecutionProviderId;

  isMissingProviderSessionError(error: string | undefined): boolean {
    return isMissingDeepAgentSessionError(error);
  }

  async prepare(
    input: AgentExecutionAdapterPrepareInput,
  ): Promise<PreparedAgentExecution> {
    const runnerPath = path.join(
      input.hostRuntime.runnerDistDir,
      '..',
      'adapters',
      'llm',
      'deepagents-langchain',
      'runner',
      'index.js',
    );
    if (!fs.existsSync(runnerPath)) {
      throw new Error(
        'Host runtime is missing required DeepAgents execution adapter runner files. Reinstall Gantry from npm and restart.',
      );
    }

    validateDeepAgentCredentialProjection({
      entry: input.effectiveModelEntry,
      projection: input.modelCredentialProjection,
    });

    const packageRoot = input.packageRootFromRunner(runnerPath);
    const relativeRunnerPath = path.relative(packageRoot, runnerPath);
    if (
      relativeRunnerPath.startsWith('..') ||
      path.isAbsolute(relativeRunnerPath)
    ) {
      throw new Error(
        'DeepAgents execution adapter runner path escaped the Gantry package root.',
      );
    }

    // Adapter-owned runtime config dir is scratch only.
    // Live continuity is not file-backed: the runner uses LangGraph's official
    // PostgresSaver keyed by the Gantry provider session id.
    const runtimeScratchRoot = path.join(input.groupDir, '.llm-runtime');
    const runtimeConfigDir = path.join(
      runtimeScratchRoot,
      `deepagents-${safePathSegment(input.input.runId ?? randomUUID())}`,
    );
    fs.mkdirSync(runtimeConfigDir, { recursive: true, mode: 0o700 });

    const modelCredentialEnv = projectDeepAgentModelCredentialEnv(
      input.modelCredentialProjection.env,
    );

    const env: NodeJS.ProcessEnv = {};
    if (input.effectiveModel) {
      env[GANTRY_DEEPAGENTS_MODEL_ID_ENV] = input.effectiveModel;
    }
    // The runner builds the LangChain model from the resolved entry's provider,
    // not by sniffing which credential env var is set. Project the provider id
    // (modelRoute.id) so the runner selects the correct LangChain class. The
    // gated cache_control mode is derived on the HOST from the model's cache
    // descriptor (the runner must not import the catalog) and projected so the
    // runner only adds explicit breakpoints when the sub-model needs them.
    if (input.effectiveModelEntry) {
      env[GANTRY_DEEPAGENTS_MODEL_PROVIDER_ENV] =
        input.effectiveModelEntry.modelRoute.id;
      const promptCache = resolveDeepAgentsPromptCache({
        modelEntry: input.effectiveModelEntry,
        conversationId: input.input.chatJid,
        threadId: input.input.threadId,
        accessFingerprint: input.input.providerSessionAccessFingerprint,
      });
      env[GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL_ENV] = promptCache.cacheMode;
      if (promptCache.promptCacheKey) {
        env[GANTRY_DEEPAGENTS_PROMPT_CACHE_KEY_ENV] =
          promptCache.promptCacheKey;
      }
      // Project the curated window only when the catalog declares one; absent ->
      // the runner uses the library's real profile (gpt-5.5/gpt-5.4).
      const contextWindowTokens = input.effectiveModelEntry.contextWindowTokens;
      if (
        typeof contextWindowTokens === 'number' &&
        Number.isFinite(contextWindowTokens) &&
        contextWindowTokens > 0
      ) {
        env[GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS_ENV] =
          String(contextWindowTokens);
      }
      const openRouterRouting = openRouterProviderRoutingEnv(
        input.effectiveModelEntry.providerRouting?.openrouter,
      );
      if (openRouterRouting) {
        env[GANTRY_DEEPAGENTS_OPENROUTER_PROVIDER_ROUTING_ENV] =
          openRouterRouting;
      }
    }

    const runnerInputPatch: PreparedAgentExecution['runnerInputPatch'] = {};
    if (Object.keys(modelCredentialEnv).length > 0) {
      runnerInputPatch.modelCredentialEnv = modelCredentialEnv;
    }
    if (!input.input.isScheduledJob) {
      const postgresUrl = input.runtimeStorage?.postgresUrl?.trim() ?? '';
      const postgresUrlEnv =
        input.runtimeStorage?.postgresUrlEnv ?? 'GANTRY_DATABASE_URL';
      const postgresSchema = input.runtimeStorage?.postgresSchema ?? 'gantry';
      if (!postgresUrl) {
        throw new Error(
          `DeepAgents live sessions require runtime Postgres storage. Set ${postgresUrlEnv} before using DeepAgents live turns.`,
        );
      }
      const checkpointSchema = deepAgentsCheckpointSchema(postgresSchema);
      await ensureDeepAgentsCheckpointSchema({
        databaseUrl: postgresUrl,
        schema: checkpointSchema,
      });
      runnerInputPatch.deepAgentCheckpointer = {
        databaseUrl: postgresUrl,
        schema: checkpointSchema,
      };
    }
    const deepAgentSkills = await resolveDeepAgentSkillProjection({
      selectedSkillIds: input.input.attachedSkillSourceIds,
      skillRepository: input.options?.skillRepository,
      skillArtifactStore: input.options?.skillArtifactStore,
      skillContext: input.options?.skillContext,
    });
    if (deepAgentSkills) {
      runnerInputPatch.deepAgentSkills = deepAgentSkills;
    }
    runnerInputPatch.semanticCapabilities =
      input.input.semanticCapabilities ?? [];

    return {
      providerId: this.id,
      runnerPath,
      runnerArgs: [runnerPath],
      runtimeConfigDir,
      runnerInputPatch,
      env,
      // v1 is tool-less with raw filesystem authority disabled in the runner; no
      // protected-path projection beyond the adapter-owned config dir is needed.
      protectedFilesystemPaths: [runtimeConfigDir],
      protectedFilesystemDenyWritePaths: [runtimeConfigDir],
      runtimeDetails: [
        `executionProvider=${this.id}`,
        `runner=${runnerPath}`,
        `configDir=${runtimeConfigDir}`,
        `checkpointSchema=${deepAgentsCheckpointSchema(input.runtimeStorage?.postgresSchema ?? 'gantry')}`,
      ],
      cleanup: () => {
        fs.rmSync(runtimeConfigDir, { recursive: true, force: true });
      },
    };
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function createDeepAgentsLangChainExecutionAdapter(): AgentExecutionAdapter {
  return new DeepAgentsLangChainExecutionAdapter();
}
