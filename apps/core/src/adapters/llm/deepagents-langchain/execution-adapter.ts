import fs from 'fs';
import path from 'path';

import type {
  AgentExecutionAdapter,
  AgentExecutionAdapterPrepareInput,
  AgentExecutionProviderId,
  PreparedAgentExecution,
} from '../../../application/agent-execution/agent-execution-adapter.js';
import { projectDeepAgentModelCredentialEnv } from './model-credential-env.js';
import { validateDeepAgentCredentialProjection } from './credential-validation.js';
import { isMissingDeepAgentSessionError } from './runner/session-store.js';
import { resolveModelCacheSupport } from '../../../shared/model-cache-support.js';

const GANTRY_DEEPAGENTS_MODEL_ID_ENV = 'GANTRY_DEEPAGENTS_MODEL_ID';
const GANTRY_DEEPAGENTS_MODEL_PROVIDER_ENV = 'GANTRY_DEEPAGENTS_MODEL_PROVIDER';
const GANTRY_DEEPAGENTS_SESSIONS_DIR_ENV = 'GANTRY_DEEPAGENTS_SESSIONS_DIR';
const GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL_ENV =
  'GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL';
// Curated context window for empty-profile models (see model-catalog.ts). The
// runner passes it as the LangChain model profile's `maxInputTokens` so
// DeepAgents summarizes at 85% of the real window and context-usage reports a
// correct %. Omitted for ids with a real library profile (gpt-5.5/gpt-5.4) so
// the runner leaves that profile untouched.
const GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS_ENV =
  'GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS';

// Maps the resolved model's prompt-cache request control (catalog descriptor) to
// the runner's gated cache_control mode. 'provider_automatic_prefix' (OpenAI
// gpt, OpenRouter Kimi) -> 'automatic' (inject nothing, the upstream caches the
// prefix); 'cache_control_blocks' (Anthropic/Gemini/Qwen sub-models) ->
// 'explicit' (runner adds ephemeral breakpoints); otherwise 'none'.
function cachePromptControlMode(
  requestControl: 'none' | 'cache_control_blocks' | 'provider_automatic_prefix',
): 'automatic' | 'explicit' | 'none' {
  switch (requestControl) {
    case 'provider_automatic_prefix':
      return 'automatic';
    case 'cache_control_blocks':
      return 'explicit';
    default:
      return 'none';
  }
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

    // Adapter-owned runtime config dir holds the adapter-private session
    // projection (LangChain message history) under the per-group .llm-runtime.
    const runtimeConfigDir = path.join(
      input.groupDir,
      '.llm-runtime',
      'deepagents',
    );
    const sessionsDir = path.join(runtimeConfigDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

    const modelCredentialEnv = projectDeepAgentModelCredentialEnv(
      input.modelCredentialProjection.env,
    );

    const env: NodeJS.ProcessEnv = {
      [GANTRY_DEEPAGENTS_SESSIONS_DIR_ENV]: sessionsDir,
    };
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
      env[GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL_ENV] = cachePromptControlMode(
        resolveModelCacheSupport(input.effectiveModelEntry).prompt
          .requestControl,
      );
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
    }

    const runnerInputPatch: PreparedAgentExecution['runnerInputPatch'] = {};
    if (Object.keys(modelCredentialEnv).length > 0) {
      runnerInputPatch.modelCredentialEnv = modelCredentialEnv;
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
      ],
      cleanup: () => {
        /* retain session projection across live turns; no per-run temp to clean */
      },
    };
  }
}

export function createDeepAgentsLangChainExecutionAdapter(): AgentExecutionAdapter {
  return new DeepAgentsLangChainExecutionAdapter();
}
