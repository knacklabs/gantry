import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationRoute } from '@core/domain/types.js';
import type { AgentInput } from '@core/runtime/agent-spawn-types.js';
import { compileSpawnSystemPrompt } from '@core/runtime/agent-spawn-prompt.js';

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
  withLogContext: (_context: unknown, callback: () => unknown) => callback(),
  updateLogContext: vi.fn(),
}));

vi.mock('@core/platform/workspace-folder.js', () => ({
  resolveWorkspaceFolderPath: (folder: string) => `/data/agents/${folder}`,
}));

const group: ConversationRoute = {
  name: 'Team',
  folder: 'team',
  trigger: '',
  added_at: '2026-01-01T00:00:00.000Z',
  conversationKind: 'dm',
};

const agentInput: AgentInput = {
  prompt: 'hello',
  workspaceFolder: 'team',
  chatJid: 'tg:1001',
};

function compile(overrides: {
  group?: Partial<ConversationRoute>;
  agentInput?: Partial<AgentInput>;
}): Promise<string> {
  return compileSpawnSystemPrompt({
    group: { ...group, ...(overrides.group ?? {}) },
    agentInput: { ...agentInput, ...(overrides.agentInput ?? {}) },
    appId: 'default',
    accessPreset: 'full',
    modelIdentity: {
      alias: 'Fable 5',
      modelId: 'claude-fable-5',
      provider: 'Anthropic API',
    },
    fileArtifactStore: () => undefined,
    measureAsync: (_name, fn) => fn(),
  });
}

describe('compileSpawnSystemPrompt', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('threads model identity and spawn context into the compiled profile', async () => {
    const prompt = await compile({});

    expect(prompt).toContain(
      '- You are running on Fable 5 (claude-fable-5) via Anthropic API. State this plainly if the user asks which model you are; deeper runtime internals stay internal.',
    );
    expect(prompt).toContain('- Channel: Telegram direct message.');
    expect(prompt).toContain('- Workspace root: /data/agents/team.');
    expect(prompt).toContain('New user messages may arrive mid-run');
  });

  it('threads job context for scheduled job spawns', async () => {
    const prompt = await compile({
      group: { conversationKind: 'channel' },
      agentInput: {
        chatJid: 'sl:C1',
        isScheduledJob: true,
        jobId: 'job-9',
        jobName: 'Daily digest',
      },
    });

    expect(prompt).toContain('- Channel: Slack group conversation.');
    expect(prompt).toContain(
      '- This run executes scheduled job "Daily digest" (job-9).',
    );
    expect(prompt).not.toContain('New user messages may arrive mid-run');
  });

  it('compiles byte-identical profiles across different clock times (cache safety)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T10:00:00.000Z'));
    const first = await compile({});
    vi.setSystemTime(new Date('2026-07-21T22:33:44.000Z'));
    const second = await compile({});

    expect(second).toBe(first);
  });
});
