import type { NewMessage } from '../domain/types.js';
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  type AgentCommandContext,
  type AgentCommandModule,
} from '../application/commands/agent-command-types.js';

export interface AgentCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  advanceCursor: (message: Pick<NewMessage, 'timestamp' | 'id'>) => void;
  getAgentCommand: (name: string) => Promise<AgentCommandModule | null>;
  buildAgentCommandContext: () => AgentCommandContext;
}

class CommandTimeoutError extends Error {}

async function withTimeout(p: Promise<string>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<string>((_, reject) => {
        timer = setTimeout(
          () => reject(new CommandTimeoutError('command timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function handleAgentCommand(input: {
  name: string;
  deps: AgentCommandDeps;
  cmdMsg: Pick<NewMessage, 'timestamp' | 'id'>;
  sanitizeErrorText: (text: string) => string;
}): Promise<{ handled: true; success: true }> {
  const { name, deps, cmdMsg, sanitizeErrorText } = input;
  deps.advanceCursor(cmdMsg);

  let mod: AgentCommandModule | null;
  try {
    mod = await deps.getAgentCommand(name);
    // eslint-disable-next-line no-catch-all/no-catch-all -- A loader failure must surface as a sanitized message, never crash the run.
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.sendMessage(`/${name} failed: ${sanitizeErrorText(message)}`);
    return { handled: true, success: true };
  }
  if (!mod) {
    await deps.sendMessage(`/${name} is unavailable in this runtime.`);
    return { handled: true, success: true };
  }

  if (mod.ackOnStart) {
    await deps.sendMessage(mod.ackOnStart);
    await deps.setTyping(true).catch(() => {});
  }

  try {
    const result = await withTimeout(
      mod.run(deps.buildAgentCommandContext()),
      mod.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    );
    await deps.sendMessage(result);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Any command failure must surface as a sanitized message, never crash the run.
  } catch (err) {
    if (err instanceof CommandTimeoutError) {
      await deps.sendMessage(`/${name} timed out.`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await deps.sendMessage(`/${name} failed: ${sanitizeErrorText(message)}`);
    }
  } finally {
    if (mod.ackOnStart) await deps.setTyping(false).catch(() => {});
  }
  return { handled: true, success: true };
}
