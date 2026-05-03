/**
 * MyClaw Agent Runner
 * Runs as the child agent process, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full agent input JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to MYCLAW_IPC_INPUT_DIR
 *          Files: {type:"message", text:"..."}.json, polled and consumed
 *          Sentinel: MYCLAW_IPC_INPUT_DIR/_close signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted. Final marker after loop ends signals completion.
 */

import {
  drainIpcInput,
  prepareInteractiveIpcInputDir,
  shouldClose,
} from './ipc-input.js';
import { readStdin } from './input.js';
import { log } from './logging.js';
import {
  resolveConfiguredModel,
  resolveThinkingOptions,
} from './model-config.js';
import { writeOutput } from './output.js';
import { runQuery } from './query-loop.js';
import { buildSdkEnv, resolveMcpServerPath } from './runtime-env.js';
import { runScript } from './script-runner.js';
import {
  parseSessionSlashCommand,
  runSessionSlashCommand,
} from './session-slash.js';
import type { AgentRunnerInput } from './types.js';

async function main(): Promise<void> {
  let agentInput: AgentRunnerInput;

  try {
    const stdinData = await readStdin();
    agentInput = JSON.parse(stdinData) as AgentRunnerInput;
    log(`Received input for group: ${agentInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const sdkEnv = buildSdkEnv();
  const mcpServerPath = resolveMcpServerPath(import.meta.url);
  const configuredModel = resolveConfiguredModel();
  const configuredThinking = resolveThinkingOptions(agentInput.thinking);
  if (configuredModel.model) {
    log(
      `Configured model: ${configuredModel.model} (source: ${configuredModel.source})`,
    );
  } else {
    log('Configured model: CLI default (no ANTHROPIC_MODEL set)');
  }
  log(`Configured thinking: ${configuredThinking.description}`);

  if (!agentInput.isScheduledJob) {
    prepareInteractiveIpcInputDir();
  }

  let prompt = buildInitialPrompt(agentInput);
  const compiledSystemPrompt = agentInput.compiledSystemPrompt?.trim();
  const sessionSlashCommand = parseSessionSlashCommand(prompt);

  if (sessionSlashCommand) {
    const slashResult = await runSessionSlashCommand({
      command: sessionSlashCommand.command,
      kind: sessionSlashCommand.kind,
      sdkEnv,
      assistantName: agentInput.assistantName,
      configuredModel: configuredModel.model,
      configuredThinking: configuredThinking.thinking,
      configuredEffort: configuredThinking.effort,
      systemPromptAppend: compiledSystemPrompt,
      persona: agentInput.persona,
    });

    if (slashResult.status === 'error') {
      process.exit(1);
    }
    return;
  }

  if (agentInput.script && agentInput.isScheduledJob) {
    const scriptPrompt = await runScheduledScript(agentInput, sdkEnv);
    if (!scriptPrompt) return;
    prompt = scriptPrompt;
  }

  if (agentInput.isScheduledJob) {
    await runScheduledQuery({
      prompt,
      mcpServerPath,
      agentInput,
      sdkEnv,
      configuredModel: configuredModel.model,
      configuredThinking: configuredThinking.thinking,
      configuredEffort: configuredThinking.effort,
    });
    return;
  }

  await runInteractiveQueryLoop({
    prompt,
    mcpServerPath,
    agentInput,
    sdkEnv,
    configuredModel: configuredModel.model,
    configuredThinking: configuredThinking.thinking,
    configuredEffort: configuredThinking.effort,
  });
}

function buildInitialPrompt(agentInput: AgentRunnerInput): string {
  let prompt = agentInput.prompt;
  if (agentInput.isScheduledJob) {
    prompt = `[SCHEDULED JOB - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  if (!agentInput.isScheduledJob) {
    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(
        `Draining ${pending.length} pending IPC messages into initial prompt`,
      );
      prompt += '\n' + pending.join('\n');
    }
  }
  return prompt;
}

async function runScheduledScript(
  agentInput: AgentRunnerInput,
  sdkEnv: Record<string, string | undefined>,
): Promise<string | null> {
  if (!agentInput.script) return null;

  log('Running scheduler job script...');
  const scriptResult = await runScript(agentInput.script, sdkEnv);

  if (!scriptResult || !scriptResult.wakeAgent) {
    const reason = scriptResult ? 'wakeAgent=false' : 'script error/no output';
    log(`Script decided not to wake agent: ${reason}`);
    writeOutput({
      status: 'success',
      result: null,
    });
    return null;
  }

  log(`Script wakeAgent=true, enriching prompt with data`);
  return `[SCHEDULED JOB]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${agentInput.prompt}`;
}

async function runScheduledQuery(opts: {
  prompt: string;
  mcpServerPath: string;
  agentInput: AgentRunnerInput;
  sdkEnv: Record<string, string | undefined>;
  configuredModel?: string;
  configuredThinking?: Parameters<typeof runQuery>[5];
  configuredEffort?: Parameters<typeof runQuery>[6];
}): Promise<void> {
  let diagnosticSessionId: string | undefined;
  log('Starting one-shot scheduled query with ephemeral SDK session...');
  try {
    const queryResult = await runQuery(
      opts.prompt,
      opts.mcpServerPath,
      opts.agentInput,
      opts.sdkEnv,
      opts.configuredModel,
      opts.configuredThinking,
      opts.configuredEffort,
      false,
    );
    if (queryResult.newSessionId) {
      diagnosticSessionId = queryResult.newSessionId;
    }
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: diagnosticSessionId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Scheduled job error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: diagnosticSessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

async function runInteractiveQueryLoop(opts: {
  prompt: string;
  mcpServerPath: string;
  agentInput: AgentRunnerInput;
  sdkEnv: Record<string, string | undefined>;
  configuredModel?: string;
  configuredThinking?: Parameters<typeof runQuery>[5];
  configuredEffort?: Parameters<typeof runQuery>[6];
}): Promise<void> {
  let diagnosticSessionId: string | undefined;

  try {
    log(
      `Starting live streaming query with ${opts.agentInput.sessionId ? `resumed SDK session ${opts.agentInput.sessionId}` : 'new persistent SDK session'}...`,
    );
    const queryResult = await runQuery(
      opts.prompt,
      opts.mcpServerPath,
      opts.agentInput,
      opts.sdkEnv,
      opts.configuredModel,
      opts.configuredThinking,
      opts.configuredEffort,
      true,
    );
    if (queryResult.newSessionId) {
      diagnosticSessionId = queryResult.newSessionId;
    }
    if (queryResult.closedDuringQuery) {
      log('Close sentinel consumed during query, exiting');
      return;
    }
    shouldClose();
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: diagnosticSessionId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: diagnosticSessionId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
