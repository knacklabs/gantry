import {
  query,
  type EffortLevel,
  type ThinkingConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { buildSystemPrompt } from './system-prompt.js';
import { log } from './logging.js';
import { writeOutput } from './output.js';
import { WORKSPACE_GROUP_DIR } from './runtime-env.js';
import type { SessionSlashCommand } from './types.js';

interface SessionSlashRunOptions {
  command: string;
  kind: 'model';
  sdkEnv: Record<string, string | undefined>;
  assistantName?: string;
  configuredModel?: string;
  configuredThinking?: ThinkingConfig;
  configuredEffort?: EffortLevel;
  systemPromptAppend?: string;
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
        allowedTools: [],
        env: opts.sdkEnv,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
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
