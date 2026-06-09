import { describe, expect, it } from 'vitest';
import { handleAgentCommand } from '@core/session/session-agent-command.js';
import type { AgentCommandModule } from '@core/application/commands/agent-command-types.js';

function makeDeps(mod: AgentCommandModule | null) {
  const sent: string[] = [];
  return {
    sent,
    deps: {
      sendMessage: async (t: string) => void sent.push(t),
      setTyping: async () => {},
      advanceCursor: () => {},
      getAgentCommand: async () => mod,
      buildAgentCommandContext: () => ({
        conversationId: 'conversation:wa:91',
        conversationJid: 'wa:91',
        threadId: null,
      }),
    },
  };
}

const cmdMsg = { id: 'm1', timestamp: '2026-01-01T00:00:00Z' };
const sanitize = (s: string) => s;

describe('handleAgentCommand', () => {
  it('runs the command and relays its result', async () => {
    const mod: AgentCommandModule = {
      name: 'do-thing',
      description: 'd',
      visibility: 'operator',
      async run() {
        return 'done: 3 records';
      },
    };
    const { sent, deps } = makeDeps(mod);
    const res = await handleAgentCommand({
      name: 'do-thing',
      deps,
      cmdMsg,
      sanitizeErrorText: sanitize,
    });
    expect(res).toEqual({ handled: true, success: true });
    expect(sent).toEqual(['done: 3 records']);
  });

  it('sends ackOnStart before the result', async () => {
    const mod: AgentCommandModule = {
      name: 'slow',
      description: 'd',
      visibility: 'operator',
      ackOnStart: 'On it.',
      async run() {
        return 'finished';
      },
    };
    const { sent, deps } = makeDeps(mod);
    await handleAgentCommand({
      name: 'slow',
      deps,
      cmdMsg,
      sanitizeErrorText: sanitize,
    });
    expect(sent).toEqual(['On it.', 'finished']);
  });

  it('reports "unavailable" when the module is missing', async () => {
    const { sent, deps } = makeDeps(null);
    await handleAgentCommand({
      name: 'ghost',
      deps,
      cmdMsg,
      sanitizeErrorText: sanitize,
    });
    expect(sent[0]).toMatch(/unavailable/i);
  });

  it('reports a sanitized failure when run() throws', async () => {
    const mod: AgentCommandModule = {
      name: 'boom',
      description: 'd',
      visibility: 'operator',
      async run() {
        throw new Error('kaboom');
      },
    };
    const { sent, deps } = makeDeps(mod);
    await handleAgentCommand({
      name: 'boom',
      deps,
      cmdMsg,
      sanitizeErrorText: sanitize,
    });
    expect(sent[0]).toMatch(/\/boom failed: kaboom/);
  });

  it('times out a slow command', async () => {
    const mod: AgentCommandModule = {
      name: 'hang',
      description: 'd',
      visibility: 'operator',
      timeoutMs: 10,
      run: () => new Promise((r) => setTimeout(() => r('late'), 1000)),
    };
    const { sent, deps } = makeDeps(mod);
    await handleAgentCommand({
      name: 'hang',
      deps,
      cmdMsg,
      sanitizeErrorText: sanitize,
    });
    expect(sent[0]).toMatch(/timed out/i);
  });

  it('clears typing after an error when ackOnStart was set', async () => {
    const typing: boolean[] = [];
    const sent: string[] = [];
    const deps = {
      sendMessage: async (t: string) => void sent.push(t),
      setTyping: async (v: boolean) => void typing.push(v),
      advanceCursor: () => {},
      getAgentCommand: async () => ({
        name: 'boom', description: 'd', visibility: 'operator' as const,
        ackOnStart: 'On it.', async run() { throw new Error('nope'); },
      }),
      buildAgentCommandContext: () => ({ conversationId: 'c', conversationJid: 'wa:1', threadId: null }),
    };
    await handleAgentCommand({ name: 'boom', deps, cmdMsg, sanitizeErrorText: sanitize });
    expect(typing).toEqual([true, false]);
    expect(sent).toEqual(['On it.', '/boom failed: nope']);
  });
});
