/**
 * Gantry DeepAgents (LangChain) Agent Runner
 *
 * Runs as the child agent process for the `deepagents:langchain` execution
 * adapter. Receives full AgentInput JSON via stdin (read until EOF), executes a
 * tool-less DeepAgents run through Gantry's loopback model gateway, and emits
 * provider-neutral runner output frames on stdout (see runner/runner-frame.ts).
 *
 * Input protocol:
 *   Stdin: full agent input JSON (read until EOF)
 *   IPC:   live follow-up messages as JSON files under GANTRY_IPC_INPUT_DIR
 *          ({type:"message", text:"..."}.json); a `_close` sentinel ends it.
 *
 * Stdout protocol: each frame wrapped in OUTPUT_START/OUTPUT_END markers.
 */

import { runDeepAgentTurn } from './deep-agent-runner.js';
import {
  drainIpcInput,
  prepareInteractiveIpcInputDir,
  shouldClose,
} from '../../../../runner/runner-ipc-input.js';
import {
  readRunnerStdin,
  writeRunnerFrame,
} from '../../../../runner/runner-frame.js';
import {
  DeepAgentSessionStore,
  type PersistedTurnMessage,
} from './session-store.js';
import type { DeepAgentRunnerInput } from './types.js';

function log(message: string): void {
  if (process.env.GANTRY_RUNNER_LOG === '1') {
    process.stderr.write(`[deepagents-runner] ${message}\n`);
  }
}

function resolveSessionsDir(): string {
  const dir = process.env.GANTRY_DEEPAGENTS_SESSIONS_DIR?.trim();
  if (!dir) {
    throw new Error(
      'Missing required environment variable: GANTRY_DEEPAGENTS_SESSIONS_DIR',
    );
  }
  return dir;
}

function resolveModelId(agentInput: DeepAgentRunnerInput): string {
  const fromEnv = process.env.GANTRY_DEEPAGENTS_MODEL_ID?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    'DeepAgents runner is missing GANTRY_DEEPAGENTS_MODEL_ID for the resolved model route.',
  );
}

async function runScheduled(agentInput: DeepAgentRunnerInput): Promise<void> {
  // Scheduled jobs are ephemeral: no session persistence (mirrors the Anthropic
  // runner's isScheduledJob path). A diagnostic session id is still emitted.
  const store = new DeepAgentSessionStore(resolveSessionsDir());
  const diagnosticSessionId = store.newSessionId();
  try {
    await runDeepAgentTurn({
      agentInput,
      modelId: resolveModelId(agentInput),
      priorMessages: [],
      newSessionId: diagnosticSessionId,
      emit: writeRunnerFrame,
    });
  } catch (err) {
    writeRunnerFrame({
      status: 'error',
      result: null,
      newSessionId: diagnosticSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

async function runInteractive(agentInput: DeepAgentRunnerInput): Promise<void> {
  const store = new DeepAgentSessionStore(resolveSessionsDir());
  prepareInteractiveIpcInputDir();

  const sessionId = agentInput.sessionId ?? store.newSessionId();
  try {
    // Live continuity: resume the adapter-private session if one was passed,
    // else start a fresh one. A missing/corrupt session file throws here and
    // surfaces as the host's stale-session retry (isMissingProviderSessionError)
    // before any session frame is emitted, so the host does not adopt a bogus id.
    const priorMessages: PersistedTurnMessage[] = agentInput.sessionId
      ? store.load(agentInput.sessionId)
      : [];

    // Emit the session id as soon as the resume is validated so the host
    // persists the provider session before the run completes (launchd restarts
    // can kill an active run mid-stream).
    writeRunnerFrame({
      status: 'success',
      result: null,
      newSessionId: sessionId,
    });

    let turnInput = agentInput;
    const pending = drainIpcInput(log);
    if (pending.length > 0) {
      turnInput = {
        ...agentInput,
        prompt: `${agentInput.prompt}\n${pending.join('\n')}`,
      };
    }

    const result = await runDeepAgentTurn({
      agentInput: turnInput,
      modelId: resolveModelId(agentInput),
      priorMessages,
      newSessionId: sessionId,
      emit: writeRunnerFrame,
    });
    store.save(sessionId, result.messages);
    shouldClose();
    writeRunnerFrame({
      status: 'success',
      result: null,
      newSessionId: sessionId,
    });
  } catch (err) {
    writeRunnerFrame({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let agentInput: DeepAgentRunnerInput;
  try {
    const stdinData = await readRunnerStdin();
    agentInput = JSON.parse(stdinData) as DeepAgentRunnerInput;
    log(`Received input for group: ${agentInput.workspaceFolder}`);
  } catch (err) {
    writeRunnerFrame({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
    return;
  }

  if (agentInput.isScheduledJob) {
    await runScheduled(agentInput);
    return;
  }
  await runInteractive(agentInput);
}

void main();
