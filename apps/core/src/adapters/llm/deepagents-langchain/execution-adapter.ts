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

const GANTRY_DEEPAGENTS_MODEL_ID_ENV = 'GANTRY_DEEPAGENTS_MODEL_ID';
const GANTRY_DEEPAGENTS_SESSIONS_DIR_ENV = 'GANTRY_DEEPAGENTS_SESSIONS_DIR';

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
