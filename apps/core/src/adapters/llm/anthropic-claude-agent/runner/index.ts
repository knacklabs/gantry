/**
 * Gantry Agent Runner
 * Runs as the child agent process, receives config via stdin, outputs result to stdout.
 *
 * Input protocol:
 *   Stdin: Full agent input JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to GANTRY_IPC_INPUT_DIR
 *          Files: {type:"message", text:"..."}.json, polled and consumed
 *          Sentinel: GANTRY_IPC_INPUT_DIR/_close signals session end
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
import {
  parseSessionSlashCommand,
  runSessionSlashCommand,
} from './session-slash.js';
import type { AgentRunnerInput } from './types.js';
import { sdkSandboxBlockedRuntimeEvents } from './sandbox-events.js';

const SCHEDULED_JOB_REPORT_INSTRUCTIONS = [
  '[SCHEDULED JOB - The following message was sent automatically and is not coming directly from the user or group.]',
  '',
  'Before finishing, include a short user-facing section titled "Final Job Report".',
  'Report what happened, what changed, and what should happen next. Include counts when relevant, such as found, added, skipped, and errors. If nothing changed, say "Completed, no changes."',
  'Keep the report concise and avoid implementation details unless the job is blocked and needs user or agent action.',
].join('\n');

const AUTONOMOUS_TOOL_CONTRACT_INSTRUCTIONS = [
  'Autonomous tool contract:',
  '- Use only the durable tool rules listed below for this autonomous run.',
  '- Tool Access Requirements are access preflight checks only. They do not require using every listed tool in the final report.',
  '- If a required access rule is no longer needed for this job, use scheduler_update_job to remove it from tool_access_requirements.',
  '- For scoped RunCommand rules, invoke the matching command directly as its own Bash command leaf. Do not wrap it in python -c, node -e, sh -c, bash -c, eval, or another generated script.',
  '- If a scoped RunCommand rule ends with *, pass data as ordinary command arguments to that reviewed command. Do not create a separate wrapper command.',
  '- If no durable rule covers the action you need, stop and explain the missing reviewed capability in the final report.',
].join('\n');

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

  const sdkEnv = buildSdkEnv(agentInput.modelCredentialEnv);
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

  const prompt = buildInitialPrompt(agentInput);
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
    prompt = `${SCHEDULED_JOB_REPORT_INSTRUCTIONS}\n\n${AUTONOMOUS_TOOL_CONTRACT_INSTRUCTIONS}\n\n${autonomousToolContract(agentInput.allowedTools)}\n\n${toolAccessRequirementContract(agentInput.toolAccessRequirements)}\n\n${prompt}`;
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

function autonomousToolContract(allowedTools?: readonly string[]): string {
  const durableRules = (allowedTools ?? [])
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (durableRules.length === 0) {
    return 'Durable tool rules for this autonomous run: none declared.';
  }
  return [
    'Durable tool rules for this autonomous run:',
    ...durableRules.map((rule) => `- ${rule}`),
  ].join('\n');
}

function toolAccessRequirementContract(
  toolAccessRequirements?: readonly string[],
): string {
  const durableRules = (toolAccessRequirements ?? [])
    .map((rule) => rule.trim())
    .filter(Boolean);
  if (durableRules.length === 0) {
    return 'Tool Access Requirements for this run: none declared.';
  }
  return [
    'Tool Access Requirements already checked before launch:',
    ...durableRules.map((rule) => `- ${rule}`),
  ].join('\n');
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
      { enableIpcFollowups: false, persistSdkSession: false },
    );
    if (queryResult.newSessionId) {
      diagnosticSessionId = queryResult.newSessionId;
    }
    writeOutput({
      status: 'success',
      result: null,
      newSessionId: diagnosticSessionId,
      ...(queryResult.primeToolAttempts.length > 0
        ? { primeToolAttempts: queryResult.primeToolAttempts }
        : {}),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Scheduled job error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: diagnosticSessionId,
      error: errorMessage,
      runtimeEvents: sdkSandboxBlockedRuntimeEvents(
        opts.agentInput,
        errorMessage,
      ),
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
      `Starting live streaming query with ${opts.agentInput.sessionId ? 'resumed SDK session' : 'new persistent SDK session'}...`,
    );
    const queryResult = await runQuery(
      opts.prompt,
      opts.mcpServerPath,
      opts.agentInput,
      opts.sdkEnv,
      opts.configuredModel,
      opts.configuredThinking,
      opts.configuredEffort,
      { enableIpcFollowups: true, persistSdkSession: true },
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
      ...(queryResult.primeToolAttempts.length > 0
        ? { primeToolAttempts: queryResult.primeToolAttempts }
        : {}),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: diagnosticSessionId,
      error: errorMessage,
      runtimeEvents: sdkSandboxBlockedRuntimeEvents(
        opts.agentInput,
        errorMessage,
      ),
    });
    process.exit(1);
  }
}

main();
