import {
  query,
  type EffortLevel,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import {
  SDK_NATIVE_SKILL_DISABLE_ENV,
  SDK_NATIVE_SKILL_OVERRIDES,
} from '../native-sdk-skills.js';
import {
  buildSystemPrompt,
  includeGitInstructionsForPersona,
} from './system-prompt.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import {
  allowedOuterSandboxClaudeExecutable,
  resolveClaudeCodeExecutableFromPath,
  WORKSPACE_GROUP_DIR,
} from './runtime-env.js';
import type { SessionSlashCommand } from './types.js';
import type { AgentPersona } from '../../../../shared/agent-persona.js';

interface SessionSlashRunOptions {
  command: string;
  kind: 'model';
  sdkEnv: Record<string, string | undefined>;
  assistantName?: string;
  configuredModel?: string;
  configuredThinking?: ThinkingConfig;
  configuredEffort?: EffortLevel;
  systemPromptAppend?: string;
  persona?: AgentPersona;
  silent?: boolean;
}

interface SessionSlashRunResult {
  status: 'success' | 'error';
  newSessionId?: string;
  hadError: boolean;
  resultEmitted: boolean;
  error?: string;
}

export function parseSessionSlashCommand(
  prompt: string,
): SessionSlashCommand | null {
  const trimmed = prompt.trim();
  if (/^\/model(?:\s+\S+)?$/.test(trimmed)) {
    return { command: trimmed, kind: 'model' };
  }
  return null;
}

export async function runSessionSlashCommand(
  opts: SessionSlashRunOptions,
): Promise<SessionSlashRunResult> {
  log(
    `Handling session command: ${opts.command}${opts.silent ? ' (silent)' : ''}`,
  );

  let slashSessionId: string | undefined;
  let hadError = false;
  let resultEmitted = false;
  let errorMessage: string | undefined;
  const systemPrompt = buildSystemPrompt(opts.systemPromptAppend);
  const isolatedSdkEnv: Record<string, string | undefined> = {
    ...opts.sdkEnv,
    ...SDK_NATIVE_SKILL_DISABLE_ENV,
  };
  const claudeCodeExecutable =
    process.env.GANTRY_SANDBOX_RUNTIME_PROXY === '1'
      ? allowedOuterSandboxClaudeExecutable(
          resolveClaudeCodeExecutableFromPath(isolatedSdkEnv.PATH),
        )
      : undefined;

  try {
    for await (const message of query({
      prompt: opts.command,
      options: {
        model: opts.configuredModel,
        thinking: opts.configuredThinking,
        effort: opts.configuredEffort,
        cwd: WORKSPACE_GROUP_DIR,
        persistSession: false,
        systemPrompt,
        settings: {
          autoMemoryEnabled: false,
          includeGitInstructions: includeGitInstructionsForPersona(
            opts.persona,
          ),
          skillOverrides: SDK_NATIVE_SKILL_OVERRIDES,
        },
        skills: [],
        allowedTools: [],
        env: isolatedSdkEnv,
        ...(claudeCodeExecutable
          ? { pathToClaudeCodeExecutable: claudeCodeExecutable }
          : {}),
        permissionMode: 'default' as const,
        canUseTool: async () => ({
          behavior: 'deny' as const,
          message: 'Session slash commands cannot use tools.',
        }),
        settingSources: ['user'] as const,
      },
    })) {
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[slash-cmd] type=${msgType}`);

      if (message.type === 'system' && message.subtype === 'init') {
        slashSessionId = message.session_id;
        log(`Session after slash command: ${slashSessionId}`);
      }

      if (message.type === 'result') {
        const resultSubtype = (message as { subtype?: string }).subtype;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        const resultIsError = Boolean(resultSubtype?.startsWith('error'));

        if (resultIsError) {
          hadError = true;
          errorMessage = textResult || 'Session command failed.';
          if (!opts.silent) {
            writeOutput({
              status: 'error',
              result: null,
              error: errorMessage,
              newSessionId: slashSessionId,
            });
          }
        } else if (!opts.silent) {
          writeOutput({
            status: 'success',
            result: textResult || null,
            newSessionId: slashSessionId,
          });
        }

        resultEmitted = true;
      }
    }
  } catch (err) {
    hadError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
    log(`Slash command error: ${errorMessage}`);
    if (!opts.silent) {
      writeOutput({
        status: 'error',
        result: null,
        error: errorMessage,
        newSessionId: slashSessionId,
      });
    }
  }

  log(
    `Slash command done. hadError=${hadError}, resultEmitted=${resultEmitted}`,
  );

  if (!opts.silent) {
    if (!hadError) {
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: slashSessionId,
      });
    }
  }

  return {
    status: hadError ? 'error' : 'success',
    newSessionId: slashSessionId,
    hadError,
    resultEmitted,
    error: errorMessage,
  };
}
