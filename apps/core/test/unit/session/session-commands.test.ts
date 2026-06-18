import { describe, it, expect, vi } from 'vitest';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from '@core/session/session-commands.js';
import type { NewMessage } from '@core/domain/types.js';
import type { SessionCommandDeps } from '@core/session/session-commands.js';

describe('extractSessionCommand', () => {
  const trigger = /^@Andy\b/i;

  it('detects bare /compact', () => {
    expect(extractSessionCommand('/compact', trigger)).toEqual({
      kind: 'compact',
      raw: '/compact',
    });
  });

  it('detects bare /commands', () => {
    expect(extractSessionCommand('/commands', trigger)).toEqual({
      kind: 'commands',
      raw: '/commands',
    });
  });

  it('detects /commands with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /commands', trigger)).toEqual({
      kind: 'commands',
      raw: '/commands',
    });
  });

  it('detects /compact with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /compact', trigger)).toEqual({
      kind: 'compact',
      raw: '/compact',
    });
  });

  it('detects bare /model', () => {
    expect(extractSessionCommand('/model', trigger)).toEqual({
      kind: 'model_show',
      raw: '/model',
    });
  });

  it('detects /model with alias', () => {
    expect(extractSessionCommand('/model opus', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model opus',
      value: 'opus',
    });
  });

  it('detects /model with full model name', () => {
    expect(extractSessionCommand('/model claude-opus-4-7', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model claude-opus-4-7',
      value: 'claude-opus-4-7',
    });
  });

  it('leaves /model shorthand for catalog resolution', () => {
    expect(extractSessionCommand('/model opus-4-7', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model opus-4-7',
      value: 'opus-4-7',
    });
  });

  it('detects /models', () => {
    expect(extractSessionCommand('/models', trigger)).toEqual({
      kind: 'models_list',
      raw: '/models',
    });
  });

  it('detects /status', () => {
    expect(extractSessionCommand('/status', trigger)).toEqual({
      kind: 'status',
      raw: '/status',
    });
  });

  it('detects /model default', () => {
    expect(extractSessionCommand('/model default', trigger)).toEqual({
      kind: 'model_default',
      raw: '/model default',
    });
  });

  it('detects /model with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /model opus', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model opus',
      value: 'opus',
    });
  });

  it('detects /model why <alias|family>', () => {
    expect(extractSessionCommand('/model why gpt-oss', trigger)).toEqual({
      kind: 'model_why',
      raw: '/model why gpt-oss',
      value: 'gpt-oss',
    });
    expect(extractSessionCommand('/model why opus', trigger)).toEqual({
      kind: 'model_why',
      raw: '/model why opus',
      value: 'opus',
    });
  });

  it('detects bare /thinking', () => {
    expect(extractSessionCommand('/thinking', trigger)).toEqual({
      kind: 'thinking_show',
      raw: '/thinking',
    });
  });

  it('detects /thinking adaptive effort presets', () => {
    expect(extractSessionCommand('/thinking high', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking high',
      value: { mode: 'adaptive', effort: 'high' },
    });
  });

  it('detects /thinking enabled with budget', () => {
    expect(extractSessionCommand('/thinking enabled 4096', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking enabled 4096',
      value: { mode: 'enabled', budgetTokens: 4096 },
    });
  });

  it('detects /thinking default', () => {
    expect(extractSessionCommand('/thinking default', trigger)).toEqual({
      kind: 'thinking_default',
      raw: '/thinking default',
    });
  });

  it('rejects /compact with extra text', () => {
    expect(extractSessionCommand('/compact now please', trigger)).toBeNull();
  });

  it('rejects partial matches', () => {
    expect(extractSessionCommand('/compaction', trigger)).toBeNull();
  });

  it('rejects regular messages', () => {
    expect(
      extractSessionCommand('please compact the conversation', trigger),
    ).toBeNull();
  });

  it('handles whitespace', () => {
    expect(extractSessionCommand('  /compact  ', trigger)).toEqual({
      kind: 'compact',
      raw: '/compact',
    });
  });

  it('accepts multi-word model aliases', () => {
    expect(extractSessionCommand('/model kimi 2.6', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model kimi 2.6',
      value: 'kimi 2.6',
    });
  });

  it('rejects malformed /model variants', () => {
    expect(extractSessionCommand('/model/opus', trigger)).toBeNull();
  });

  it('rejects malformed /thinking variants', () => {
    expect(extractSessionCommand('/thinking ultra', trigger)).toBeNull();
    expect(extractSessionCommand('/thinking enabled -1', trigger)).toBeNull();
    expect(extractSessionCommand('/thinking enabled 0', trigger)).toBeNull();
  });

  it('detects bare /new', () => {
    expect(extractSessionCommand('/new', trigger)).toEqual({
      kind: 'new',
      raw: '/new',
    });
  });

  it('detects /new with trigger prefix', () => {
    expect(extractSessionCommand('@Andy /new', trigger)).toEqual({
      kind: 'new',
      raw: '/new',
    });
  });

  it('detects explicit mention-friendly !new alias for Slack', () => {
    expect(extractSessionCommand('@Andy !new', trigger)).toEqual({
      kind: 'new',
      raw: '/new',
    });
    const slackTrigger = /(?:^|\s)<@U123BOT>?(?=\s|$|[,.!?;:])/i;
    expect(extractSessionCommand('<@U123BOT> !new', slackTrigger)).toEqual({
      kind: 'new',
      raw: '/new',
    });
    expect(extractSessionCommand('<@UOTHER> !new', slackTrigger)).toBeNull();
  });

  it('does not treat natural new-session text as commands', () => {
    expect(extractSessionCommand('@Andy new', trigger)).toBeNull();
    expect(extractSessionCommand('@Andy new chat', trigger)).toBeNull();
    expect(extractSessionCommand('@Andy reset chat', trigger)).toBeNull();
    expect(extractSessionCommand('@Andy start fresh', trigger)).toBeNull();
    expect(extractSessionCommand('new', trigger)).toBeNull();
    expect(extractSessionCommand('!new', trigger)).toBeNull();
  });

  it('rejects /new with extra text', () => {
    expect(extractSessionCommand('/new later', trigger)).toBeNull();
  });

  it('detects bare /stop', () => {
    expect(extractSessionCommand('/stop', trigger)).toEqual({
      kind: 'stop',
      raw: '/stop',
    });
  });

  it('detects /dream and /memory-status', () => {
    expect(extractSessionCommand('/dream', trigger)).toEqual({
      kind: 'dream',
      raw: '/dream',
    });
    expect(extractSessionCommand('/memory-status', trigger)).toEqual({
      kind: 'memory_status',
      raw: '/memory-status',
    });
  });

  it('detects mention-friendly utility aliases for Slack', () => {
    expect(extractSessionCommand('@Andy !commands', trigger)).toEqual({
      kind: 'commands',
      raw: '/commands',
    });
    expect(extractSessionCommand('@Andy !help', trigger)).toEqual({
      kind: 'commands',
      raw: '/commands',
    });
    expect(extractSessionCommand('@Andy !status', trigger)).toEqual({
      kind: 'status',
      raw: '/status',
    });
    expect(extractSessionCommand('@Andy !memory-status', trigger)).toEqual({
      kind: 'memory_status',
      raw: '/memory-status',
    });
    expect(extractSessionCommand('@Andy !compact', trigger)).toEqual({
      kind: 'compact',
      raw: '/compact',
    });
    expect(extractSessionCommand('@Andy !stop', trigger)).toEqual({
      kind: 'stop',
      raw: '/stop',
    });
  });

  it('detects mention-friendly model and thinking aliases for Slack', () => {
    expect(extractSessionCommand('@Andy !models', trigger)).toEqual({
      kind: 'models_list',
      raw: '/models',
    });
    expect(extractSessionCommand('@Andy !model', trigger)).toEqual({
      kind: 'model_show',
      raw: '/model',
    });
    expect(extractSessionCommand('@Andy !model haiku', trigger)).toEqual({
      kind: 'model_set',
      raw: '/model haiku',
      value: 'haiku',
    });
    expect(extractSessionCommand('@Andy !model default', trigger)).toEqual({
      kind: 'model_default',
      raw: '/model default',
    });
    expect(extractSessionCommand('@Andy !thinking high', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking high',
      value: { mode: 'adaptive', effort: 'high' },
    });
  });

  it('detects /save-procedure with quoted title and body', () => {
    expect(
      extractSessionCommand(
        '/save-procedure "Deploy flow"\n1. Build\n2. Ship',
        trigger,
      ),
    ).toEqual({
      kind: 'save_procedure',
      raw: '/save-procedure "Deploy flow"\n1. Build\n2. Ship',
      title: 'Deploy flow',
      body: '1. Build\n2. Ship',
    });
  });

  it('rejects /stop with extra text', () => {
    expect(extractSessionCommand('/stop now', trigger)).toBeNull();
  });

  it('is case-sensitive for commands', () => {
    expect(extractSessionCommand('/Compact', trigger)).toBeNull();
    expect(extractSessionCommand('/Model', trigger)).toBeNull();
  });
});

describe('isSessionCommandAllowed', () => {
  it('allows trusted/admin sender (is_from_me)', () => {
    expect(isSessionCommandAllowed(true, false)).toBe(true);
  });

  it('allows explicitly allowlisted sender', () => {
    expect(isSessionCommandAllowed(false, true)).toBe(true);
  });

  it('denies sender that is neither owner nor explicitly allowlisted', () => {
    expect(isSessionCommandAllowed(false, false)).toBe(false);
  });
});

function makeMsg(
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@test',
    sender: 'user@test',
    sender_name: 'User',
    content,
    timestamp: '100',
    is_from_me: true,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SessionCommandDeps> = {},
): SessionCommandDeps {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    runAgent: vi.fn().mockResolvedValue('success'),
    closeStdin: vi.fn(),
    advanceCursor: vi.fn(),
    formatMessages: vi.fn().mockReturnValue('<formatted>'),
    getDefaultModel: vi.fn().mockReturnValue(undefined),
    getGroupModelOverride: vi.fn().mockReturnValue(undefined),
    setGroupModelOverride: vi.fn(),
    getGroupThinkingOverride: vi.fn().mockReturnValue(undefined),
    setGroupThinkingOverride: vi.fn(),
    archiveCurrentSession: vi.fn().mockResolvedValue(undefined),
    onSessionArchived: vi.fn().mockResolvedValue(undefined),
    clearCurrentSession: vi.fn(),
    isSenderControlAllowlisted: vi.fn().mockReturnValue(false),
    canSenderInteract: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

const trigger = /^@Andy\b/i;

async function flushAsyncFinalizers(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('handleSessionCommand', () => {
  it('returns handled:false when no session command found', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('hello')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result.handled).toBe(false);
  });

  it('handles authorized /commands without running the agent', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/commands')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        '/commands or !commands - List available chat commands.',
      ),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('/model <alias>'),
    );
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
  });

  it('handles authorized /compact in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.archiveCurrentSession).toHaveBeenCalledWith('manual-compact');
    expect(deps.onSessionArchived).toHaveBeenCalledWith('manual-compact');
    expect(deps.sendMessage).toHaveBeenCalledWith('Compacted current session.');
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
  });

  it('denies /compact in main group when sender is not owner and not allowlisted', async () => {
    const deps = makeDeps({
      isSenderControlAllowlisted: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
  });

  it('handles authorized /new in main group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.archiveCurrentSession).toHaveBeenCalledWith('new-session');
    await flushAsyncFinalizers();
    expect(deps.onSessionArchived).toHaveBeenCalledWith('new-session');
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(
      (deps.clearCurrentSession as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      (deps.archiveCurrentSession as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
    expect(deps.sendMessage).toHaveBeenCalledWith('Started a fresh session.');
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
  });

  it('handles /stop by stopping current run without invoking runAgent', async () => {
    const deps = makeDeps({
      stopCurrentRun: vi.fn().mockReturnValue(true),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/stop')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.stopCurrentRun).toHaveBeenCalledTimes(1);
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('Stopping current run.');
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
  });

  it('handles /stop when nothing is active', async () => {
    const deps = makeDeps({
      stopCurrentRun: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/stop')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith('No active run to stop.');
  });

  it('handles /dream by invoking memory dreaming dependency', async () => {
    const deps = makeDeps({
      runMemoryDreaming: vi.fn().mockResolvedValue({
        promotedCount: 2,
        retiredCount: 1,
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/dream')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runMemoryDreaming).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Dreaming completed.'),
    );
  });

  it('reports deduped /dream requests without marking completion', async () => {
    const deps = makeDeps({
      runMemoryDreaming: vi.fn().mockResolvedValue({
        queued: false,
        deduped: true,
        reason: 'deduped',
        pending: 1,
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/dream')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Dreaming already in progress.'),
    );
    expect(deps.sendMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Dreaming completed.'),
    );
  });

  it('fails /dream when queue rejects non-deduped requests', async () => {
    const deps = makeDeps({
      runMemoryDreaming: vi.fn().mockResolvedValue({
        queued: false,
        deduped: false,
        reason: 'full',
        pending: 5000,
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/dream')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('/dream failed: full'),
    );
  });

  it('handles /memory-status by formatting status output', async () => {
    const deps = makeDeps({
      getMemoryStatus: vi.fn().mockResolvedValue({
        memory_enabled: true,
        items_by_kind: { fact: 3 },
        items_by_scope: { group: 3 },
        top10_most_used: [{ key: 'fact:key', retrieval_count: 12 }],
        top10_stalest: [
          { key: 'fact:key', updated_at: '2026-04-01T00:00:00Z' },
        ],
        retrieval: {
          searchMode: 'lexical_keyword',
          embeddings: 'configured',
          vectorSearch: 'inactive',
        },
        disk_kb: { profile: 10, procedures: 2, sessions: 5, journal: 1 },
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/memory-status')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.getMemoryStatus).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      [
        'Memory: on',
        'Pre-answer recall: on',
        'Search mode: full-text',
        'Semantic recall: index building. Full-text memory is still active.',
        'Last dream: never',
        'Review queue: 0',
        'Injected this run: 0',
      ].join('\n'),
    );
  });

  it('handles /save-procedure by saving explicit procedure content', async () => {
    const deps = makeDeps({
      saveProcedure: vi.fn().mockResolvedValue({ id: 'proc-1' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [
        makeMsg('/save-procedure "Deploy flow"\n1. Build\n2. Ship'),
      ],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.saveProcedure).toHaveBeenCalledWith({
      title: 'Deploy flow',
      body: '1. Build\n2. Ship',
    });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Saved procedure "Deploy flow"'),
    );
  });

  it('sends denial to interactable sender in conversation-scoped group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
  });

  it('silently consumes denied command when sender cannot interact', async () => {
    const deps = makeDeps({
      canSenderInteract: vi.fn().mockReturnValue(false),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: false })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
  });

  it('processes pre-compact messages before /compact', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).toHaveBeenCalledWith([msgs[0]], 'UTC');
    expect(deps.runAgent).toHaveBeenCalledTimes(2);
    expect(deps.runAgent).toHaveBeenCalledWith(
      '<formatted>',
      expect.any(Function),
    );
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.archiveCurrentSession).toHaveBeenCalledWith('manual-compact');
  });

  it('allows is_from_me sender in conversation-scoped group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact', { is_from_me: true })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).toHaveBeenCalledWith(
      '/compact',
      expect.any(Function),
    );
    expect(deps.archiveCurrentSession).toHaveBeenCalledWith('manual-compact');
  });

  it('allows is_from_me sender for /new in conversation-scoped group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new', { is_from_me: true })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.archiveCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('denies unauthorized /new in conversation-scoped group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new', { is_from_me: false })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.clearCurrentSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('returns success:false on pre-compact failure with no output', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('returns success:false on stopped pre-compact processing', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('stopped') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('clears session for /new without processing stale pre-command messages', async () => {
    const deps = makeDeps({ runAgent: vi.fn().mockResolvedValue('error') });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/new', { timestamp: '100' }),
      makeMsg('after reset', { timestamp: '101' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.archiveCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith('Started a fresh session.');
  });

  it('skips pre-command messages before /new and leaves post-command pending', async () => {
    const deps = makeDeps();
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/new', { timestamp: '100' }),
      makeMsg('after reset', { timestamp: '101' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.formatMessages).not.toHaveBeenCalled();
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.archiveCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
    expect(deps.advanceCursor).not.toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '101' }),
    );
  });

  it('handles /model by showing group override when present', async () => {
    const deps = makeDeps({
      getGroupModelOverride: vi.fn().mockReturnValue('claude-opus-4-7'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current model: Opus 4.7 (Anthropic) (session override).',
    );
  });

  it('handles /model by showing default model when no group override', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-6'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current model: Sonnet 4.6 (Anthropic) (chat default).',
    );
  });

  it('handles /model with no defaults configured', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue(undefined),
      getGroupModelOverride: vi.fn().mockReturnValue(undefined),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current model: CLI default (no explicit override).',
    );
  });

  it('handles /thinking by showing group override when present', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi
        .fn()
        .mockReturnValue({ mode: 'adaptive', effort: 'medium' }),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: adaptive (effort medium) (group override).',
    );
  });

  it('handles /thinking with no override configured', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue(undefined),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: adaptive (effort medium) (default).',
    );
  });

  it('handles authorized /thinking and persists override', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking high')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith({
      mode: 'adaptive',
      effort: 'high',
    });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to adaptive (effort high) for this group.',
    );
  });

  it('fails /thinking when override persistence rejects', async () => {
    const deps = makeDeps({
      setGroupThinkingOverride: vi
        .fn()
        .mockRejectedValue(new Error('persist failed')),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking high')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: false });
    expect(deps.advanceCursor).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to set thinking. Override unchanged.',
    );
  });

  it('handles /thinking default by clearing override', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking default')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(undefined);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking override cleared. Using default thinking: adaptive (effort medium).',
    );
  });

  it('fails /thinking default when override persistence rejects', async () => {
    const deps = makeDeps({
      setGroupThinkingOverride: vi
        .fn()
        .mockRejectedValue(new Error('persist failed')),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking default')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: false });
    expect(deps.advanceCursor).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to clear thinking override. Override unchanged.',
    );
  });

  it('handles authorized /model and persists override', async () => {
    const deps = makeDeps({ updateModelStatusSelection: vi.fn() });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opus')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith('opus');
    expect(deps.updateModelStatusSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionSource: 'session override',
        modelAlias: 'opus',
        model: expect.objectContaining({ displayName: 'Opus 4.8' }),
      }),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Using Opus 4.8 for this session.',
    );
  });

  it('accepts a model family alias and stores the family alias verbatim', async () => {
    const deps = makeDeps({ updateModelStatusSelection: vi.fn() });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model gpt-oss')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    // The family alias is stored verbatim; the concrete provider is picked at
    // spawn from the configured credential.
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith('gpt-oss');
    expect(deps.updateModelStatusSelection).toHaveBeenCalledWith(
      expect.objectContaining({ modelAlias: 'gpt-oss' }),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Using GPT-OSS 120B (provider auto-selected by configured key) for this session.',
    );
  });

  it('fails /model when override persistence rejects', async () => {
    const deps = makeDeps({
      setGroupModelOverride: vi
        .fn()
        .mockRejectedValue(new Error('persist failed')),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opus')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: false });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to set model to opus. Override unchanged.',
    );
  });

  it('does not persist /model override when validation fails', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opuus')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Unknown model "opuus". Did you mean "opus"? Use /models to view supported models.',
    );
  });

  it('handles /model default by clearing override and using env default when configured', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue('opus'),
      updateModelStatusSelection: vi.fn(),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model default')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith(undefined);
    expect(deps.updateModelStatusSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionSource: 'chat default',
        modelAlias: 'opus',
        model: expect.objectContaining({ displayName: 'Opus 4.8' }),
      }),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Model override cleared. Using default model: Opus 4.8 (Anthropic).',
    );
  });

  it('fails /model default when override persistence rejects', async () => {
    const deps = makeDeps({
      setGroupModelOverride: vi
        .fn()
        .mockRejectedValue(new Error('persist failed')),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model default')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: false });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.advanceCursor).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Failed to clear model override. Override unchanged.',
    );
  });

  it('handles /model default when no env default exists', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue(undefined),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model default')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith(undefined);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Model override cleared. Using CLI default model selection.',
    );
  });

  it('rejects unknown model aliases before spawning the runner', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model bad-model')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Unknown model "bad-model". Use /models to view supported models.',
    );
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
  });

  it('denies unauthorized /model in conversation-scoped group', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model opus', { is_from_me: false })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
  });

  it('/new does not archive or advance cursor when clearing rejects', async () => {
    const deps = makeDeps({
      clearCurrentSession: vi.fn().mockRejectedValue(new Error('clear failed')),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: false });
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.onSessionArchived).not.toHaveBeenCalled();
    expect(deps.advanceCursor).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      '/new failed. The session is unchanged.',
    );
  });

  it('/new schedules archive finalization before clearing but runs finalizer after reset', async () => {
    const finalizeArchive = vi.fn().mockResolvedValue(undefined);
    const prepareSessionArchive = vi.fn().mockResolvedValue(finalizeArchive);
    const deps = makeDeps({ prepareSessionArchive });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(prepareSessionArchive).toHaveBeenCalledWith('new-session');
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(prepareSessionArchive.mock.invocationCallOrder[0]).toBeLessThan(
      (deps.clearCurrentSession as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    );
    expect(
      (deps.clearCurrentSession as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0],
    ).toBeLessThan(finalizeArchive.mock.invocationCallOrder[0]);
    await flushAsyncFinalizers();
    expect(deps.onSessionArchived).toHaveBeenCalledWith('new-session');
  });

  it('/new does not run prepared archive finalizer when clearing rejects', async () => {
    const finalizeArchive = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      prepareSessionArchive: vi.fn().mockResolvedValue(finalizeArchive),
      clearCurrentSession: vi.fn().mockRejectedValue(new Error('clear failed')),
    });

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: false });
    expect(deps.prepareSessionArchive).toHaveBeenCalledWith('new-session');
    expect(finalizeArchive).not.toHaveBeenCalled();
    expect(deps.onSessionArchived).not.toHaveBeenCalled();
    expect(deps.advanceCursor).not.toHaveBeenCalled();
  });

  it('denies unauthorized /thinking in conversation-scoped group', async () => {
    const deps = makeDeps();

    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking low', { is_from_me: false })],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });

    expect(result).toEqual({ handled: true, success: true });
    expect(deps.setGroupThinkingOverride).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Session commands require admin access.',
    );
  });

  it('advances cursor to last pre-command message when pre-processing fails after output was sent', async () => {
    // Covers lines 264-265: preOutputSent=true branch
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        // Agent produces output then fails
        await onOutput({ status: 'success', result: 'partial output' });
        await onOutput({ status: 'error', result: 'something went wrong' });
        return 'error';
      }),
    });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    // When pre-command fails but output was already sent, cursor advances
    // to the last pre-command message and returns success:true (no retry)
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '99' }),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('continues /new even when archiveCurrentSession throws', async () => {
    // Covers line 277: catch block for archiveCurrentSession error
    const deps = makeDeps({
      archiveCurrentSession: vi
        .fn()
        .mockRejectedValue(new Error('archive failed')),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    // /new should still succeed — archive failure is logged but not fatal
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.clearCurrentSession).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('Started a fresh session.');
    expect(deps.advanceCursor).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: '100' }),
    );
  });

  it('calls onSessionArchived callback during /new when provided', async () => {
    // Covers line 275: onSessionArchived?.() call
    const onSessionArchived = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ onSessionArchived });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/new')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    await flushAsyncFinalizers();
    expect(onSessionArchived).toHaveBeenCalledTimes(1);
  });

  it('rejects raw provider model IDs through the catalog resolver', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model claude-opus-4-7')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Provider model ID "claude-opus-4-7" is not accepted here. Use a model alias from /models.',
    );
  });

  it('reports /compact failure when SDK compact fails', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockResolvedValue('error'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('/compact failed.');
    expect(deps.advanceCursor).not.toHaveBeenCalled();
  });

  it('reports /compact failure when SDK compact is stopped', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockResolvedValue('stopped'),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('/compact failed.');
    expect(deps.advanceCursor).not.toHaveBeenCalled();
  });

  it('reports /compact failure when SDK compact output is an error', async () => {
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (_prompt, onOutput) => {
        await onOutput({ status: 'error', result: 'too large' });
        return 'success';
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.archiveCurrentSession).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith('/compact failed. too large');
    expect(deps.advanceCursor).not.toHaveBeenCalled();
  });

  it('reports /compact failure when memory collection fails', async () => {
    const deps = makeDeps({
      archiveCurrentSession: vi
        .fn()
        .mockRejectedValue(new Error('memory collection failed')),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/compact')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      '/compact failed. Memory collection failed.',
    );
    expect(deps.advanceCursor).not.toHaveBeenCalled();
  });

  it('accepts forgiving multi-word aliases at runtime', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model kimi 2.6')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith('kimi-2.6');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Using Kimi K2.6 for this session.',
    );
  });

  it('closes stdin on pre-command success with null result', async () => {
    // Covers the closeStdin path in pre-command callback (line 249)
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        if (prompt === '<formatted>') {
          await onOutput({ status: 'success', result: 'agent response' });
          await onOutput({ status: 'success', result: null });
          return 'success';
        }
        // command stage
        await onOutput({ status: 'success', result: null });
        return 'success';
      }),
    });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.closeStdin).toHaveBeenCalled();
  });

  it('pre-command failure via hadPreError flag returns failure', async () => {
    // Covers hadPreError branch (line 253) — callback reports error, but runAgent returns 'success'
    const deps = makeDeps({
      runAgent: vi.fn().mockImplementation(async (prompt, onOutput) => {
        if (prompt === '<formatted>') {
          await onOutput({ status: 'error', result: null });
          return 'success'; // runAgent returns success, but callback had error
        }
        return 'success';
      }),
    });
    const msgs = [
      makeMsg('summarize this', { timestamp: '99' }),
      makeMsg('/compact', { timestamp: '100' }),
    ];
    const result = await handleSessionCommand({
      missedMessages: msgs,
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: false });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining('Failed to process'),
    );
  });

  it('lists curated models with default badges', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue('opus'),
      getJobModelDefaults: vi
        .fn()
        .mockReturnValue({ oneTime: 'sonnet', recurring: 'kimi' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/models')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMsg).toContain('Supported model aliases');
    expect(sentMsg).toContain('Opus 4.8');
    expect(sentMsg).toContain('Kimi K2.6');
    expect(sentMsg).toContain('chat default');
    expect(sentMsg).toContain('one-time default');
    expect(sentMsg).toContain('recurring default');
    expect(sentMsg).toContain(
      'Model families (provider auto-selected by configured key)',
    );
    expect(sentMsg).toContain('gpt-oss | GPT-OSS 120B | groq-oss > cerebras');
  });

  it('badges /models with the configured-provider set', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue('opus'),
      getConfiguredModelProviders: vi
        .fn()
        .mockResolvedValue(new Set(['cerebras'])),
    });
    await handleSessionCommand({
      missedMessages: [makeMsg('/models')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMsg).toContain('Availability');
    expect(sentMsg).toContain('available via Cerebras');
    expect(sentMsg).toContain('needs Anthropic key');
  });

  it('degrades /models to no badges when the configured set read throws', async () => {
    const deps = makeDeps({
      getDefaultModel: vi.fn().mockReturnValue('opus'),
      getConfiguredModelProviders: vi
        .fn()
        .mockRejectedValue(new Error('db down')),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/models')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMsg).not.toContain('Availability');
  });

  it('answers /model why <family> with the resolved provider and reason', async () => {
    const deps = makeDeps({
      getConfiguredModelProviders: vi
        .fn()
        .mockResolvedValue(new Set(['cerebras'])),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model why gpt-oss')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMsg).toContain('Why model family gpt-oss');
    expect(sentMsg).toContain('gpt-oss → cerebras via Cerebras');
  });

  it('answers /model why <alias> with the configured/needs-key line', async () => {
    const deps = makeDeps({
      getConfiguredModelProviders: vi.fn().mockResolvedValue(new Set()),
    });
    await handleSessionCommand({
      missedMessages: [makeMsg('/model why opus')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMsg).toContain('Why model opus');
    expect(sentMsg).toContain('needs Anthropic key');
  });

  it('shows /status with model and cache token accounting', async () => {
    const deps = makeDeps({
      getGroupModelOverride: vi.fn().mockReturnValue('sonnet'),
      getBrowserStatus: vi.fn().mockResolvedValue({
        profileName: 'c-test-abc123abc123',
        profileLabel: 'Test conversation browser',
        running: true,
        cdpReady: true,
        hasState: true,
        authMarkers: ['github.com'],
        headless: false,
      }),
      getModelStatus: vi.fn().mockReturnValue({
        scopeKey: 'test',
        selectionSource: 'session override',
        modelAlias: 'sonnet',
        contextUsage: {
          totalTokens: 150,
          maxTokens: 200_000,
          percentage: 0.075,
          model: 'sonnet',
          categories: [
            { name: 'messages', tokens: 90, percentage: 0.045 },
            { name: 'tools', tokens: 40, percentage: 0.02 },
            { name: 'system prompt', tokens: 20, percentage: 0.01 },
          ],
          apiUsage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 40,
          },
          at: '2026-05-01T00:00:00.000Z',
        },
        lastUsage: {
          model: 'sonnet',
          provider: 'anthropic',
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 40,
          cacheWriteTokens: 10,
          totalBillableInputTokens: 60,
          estimatedCostUsd: 0.002,
          cacheProvider: 'anthropic',
          cacheStatus: 'partial',
          at: '2026-05-01T00:00:00.000Z',
        },
        cumulativeUsage: {
          model: 'sonnet',
          provider: 'anthropic',
          inputTokens: 300,
          outputTokens: 60,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          totalBillableInputTokens: 220,
          estimatedCostUsd: 0.006,
          cacheProvider: 'anthropic',
          cacheStatus: 'partial',
          at: '2026-05-01T00:00:00.000Z',
        },
      }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/status')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    const sentMsg = (deps.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(sentMsg).toContain('Model status');
    expect(sentMsg).toContain('Sonnet 4.6');
    expect(sentMsg).toContain('Context: 150 / 200k tokens (0.1% used)');
    expect(sentMsg).toContain('Top context: messages 90');
    expect(sentMsg).toContain('Cache hit: current 27%, session 21%');
    expect(sentMsg).toContain('cache read 40');
    expect(sentMsg).toContain('cache write 10');
    expect(sentMsg).toContain('estimated cost $0.0020');
    expect(sentMsg).toContain('Browser status');
    expect(sentMsg).toContain('Test conversation browser');
    expect(sentMsg).toContain('running and ready');
    expect(sentMsg).toContain('github.com');
  });

  it('accepts versioned aliases and stores the recommended alias', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/model sonnet 4.6')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.runAgent).not.toHaveBeenCalled();
    expect(deps.setGroupModelOverride).toHaveBeenCalledWith('sonnet-4.6');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Using Sonnet 4.6 for this session.',
    );
  });
});

describe('getGroupMemoryStatus', () => {
  it('derives retrieval status and top-used counts from runtime inputs and memory metadata', async () => {
    vi.resetModules();
    const list = vi.fn().mockResolvedValue([
      {
        id: 'mem-1',
        appId: 'default',
        agentId: 'agent:test',
        subjectType: 'group',
        subjectId: 'test',
        groupId: 'test',
        kind: 'fact',
        key: 'unused',
        value: 'unused',
        confidence: 0.7,
        isPinned: false,
        version: 1,
        source: 'test',
        evidenceIds: [],
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        metadata: { retrievalCount: 0 },
      },
      {
        id: 'mem-2',
        appId: 'default',
        agentId: 'agent:test',
        subjectType: 'group',
        subjectId: 'test',
        groupId: 'test',
        kind: 'reference',
        key: 'used',
        value: 'used',
        confidence: 0.7,
        isPinned: false,
        version: 1,
        source: 'test',
        evidenceIds: [],
        createdAt: '2026-04-03T00:00:00.000Z',
        updatedAt: '2026-04-03T00:00:00.000Z',
        metadata: { retrievalCount: 7 },
      },
      {
        id: 'mem-3',
        appId: 'default',
        agentId: 'agent:test',
        subjectType: 'group',
        subjectId: 'test',
        groupId: 'test',
        kind: 'fact',
        key: 'json',
        value: 'json',
        confidence: 0.7,
        isPinned: false,
        version: 1,
        source: 'test',
        evidenceIds: [],
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
        sourceRefJson: JSON.stringify({ retrievalCount: 5 }),
      },
    ]);
    const dreamingStatus = vi.fn().mockResolvedValue([]);
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          list,
          dreamingStatus,
        }),
      },
    }));

    try {
      const { getGroupMemoryStatus } =
        await import('@core/runtime/group-memory-commands.js');
      const status = await getGroupMemoryStatus('test', {
        embeddings: 'configured',
      });

      expect(list).toHaveBeenCalledWith({
        appId: 'default',
        agentId: 'agent:test',
        groupId: 'test',
        subjectTypes: ['group'],
        includeCommon: false,
        limit: 100,
      });
      expect(dreamingStatus).toHaveBeenCalledWith({
        appId: 'default',
        agentId: 'agent:test',
        subjectType: 'group',
        subjectId: 'test',
        groupId: 'test',
      });
      expect(status.retrieval).toEqual({
        searchMode: 'lexical_keyword',
        embeddings: 'configured',
        vectorSearch: 'inactive',
      });
      expect(status.top10_most_used).toEqual([
        { key: 'used', retrieval_count: 7 },
        { key: 'json', retrieval_count: 5 },
        { key: 'unused', retrieval_count: 0 },
      ]);
    } finally {
      vi.doUnmock('@core/memory/app-memory-service.js');
      vi.resetModules();
    }
  });

  it('uses continuity status without calling direct dreaming status', async () => {
    vi.resetModules();
    const list = vi.fn().mockResolvedValue([]);
    const continuityStatus = vi.fn().mockResolvedValue({
      stagedCount: 2,
      promotedCount: 1,
      needsReviewCount: 3,
      lastDreamRun: {
        completedAt: '2026-04-04T00:00:00.000Z',
        summary: { staged: 99, promoted: 99, needsReview: 99 },
      },
    });
    const dreamingStatus = vi.fn().mockResolvedValue([
      {
        completedAt: '2026-04-05T00:00:00.000Z',
        summary: { staged: 10, promoted: 10, needsReview: 10 },
      },
    ]);
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          list,
          continuityStatus,
          dreamingStatus,
        }),
      },
    }));

    try {
      const { getGroupMemoryStatus } =
        await import('@core/runtime/group-memory-commands.js');
      const status = await getGroupMemoryStatus('test');

      expect(continuityStatus).toHaveBeenCalledWith({
        appId: 'default',
        agentId: 'agent:test',
        subjectType: 'group',
        subjectId: 'test',
        groupId: 'test',
      });
      expect(dreamingStatus).not.toHaveBeenCalled();
      expect(status.memory_pipeline).toEqual({
        staged: 2,
        promoted: 1,
        needs_review: 3,
      });
      expect(status.last_dream_run).toEqual({
        at: '2026-04-04T00:00:00.000Z',
        summary: JSON.stringify({ staged: 99, promoted: 99, needsReview: 99 }),
      });
    } finally {
      vi.doUnmock('@core/memory/app-memory-service.js');
      vi.resetModules();
    }
  });

  it('reports embeddings disabled when runtime settings do not configure them', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          list: vi.fn().mockResolvedValue([]),
          dreamingStatus: vi.fn().mockResolvedValue([]),
        }),
      },
    }));

    try {
      const { getGroupMemoryStatus } =
        await import('@core/runtime/group-memory-commands.js');
      const status = await getGroupMemoryStatus('test');

      expect(status.retrieval?.embeddings).toBe('disabled');
      expect(status.retrieval?.vectorSearch).toBe('inactive');
    } finally {
      vi.doUnmock('@core/memory/app-memory-service.js');
      vi.resetModules();
    }
  });

  it('threads disabled memory into the status snapshot', async () => {
    vi.resetModules();
    vi.doMock('@core/memory/app-memory-service.js', () => ({
      AppMemoryService: {
        getInstance: () => ({
          list: vi.fn().mockResolvedValue([]),
          dreamingStatus: vi.fn().mockResolvedValue([]),
        }),
      },
    }));

    try {
      const { getGroupMemoryStatus } =
        await import('@core/runtime/group-memory-commands.js');
      const status = await getGroupMemoryStatus('test', {
        memoryEnabled: false,
      });

      expect(status.memory_enabled).toBe(false);
    } finally {
      vi.doUnmock('@core/memory/app-memory-service.js');
      vi.resetModules();
    }
  });
});

describe('extractSessionCommand - additional coverage', () => {
  const trigger = /^@Andy\b/i;

  it('detects /thinking enabled (without budget)', () => {
    // Covers line 49: value === 'enabled' branch
    expect(extractSessionCommand('/thinking enabled', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking enabled',
      value: { mode: 'enabled' },
    });
  });

  it('detects /thinking off', () => {
    expect(extractSessionCommand('/thinking off', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking off',
      value: { mode: 'disabled' },
    });
  });

  it('detects /thinking disabled', () => {
    expect(extractSessionCommand('/thinking disabled', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking disabled',
      value: { mode: 'disabled' },
    });
  });

  it('detects /thinking adaptive', () => {
    expect(extractSessionCommand('/thinking adaptive', trigger)).toEqual({
      kind: 'thinking_set',
      raw: '/thinking adaptive',
      value: { mode: 'adaptive' },
    });
  });

  it('detects all effort presets', () => {
    for (const effort of ['low', 'medium', 'high', 'max'] as const) {
      expect(extractSessionCommand(`/thinking ${effort}`, trigger)).toEqual({
        kind: 'thinking_set',
        raw: `/thinking ${effort}`,
        value: { mode: 'adaptive', effort },
      });
    }
  });

  it('rejects /thinking enabled with non-integer budget', () => {
    expect(extractSessionCommand('/thinking enabled 1.5', trigger)).toBeNull();
  });

  it('rejects /thinking enabled with unsafe integer budget', () => {
    // Number.MAX_SAFE_INTEGER + 1 is not a safe integer
    expect(
      extractSessionCommand('/thinking enabled 9007199254740992', trigger),
    ).toBeNull();
  });
});

describe('handleSessionCommand - describeThinking coverage', () => {
  it('displays disabled thinking override', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue({ mode: 'disabled' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: disabled (group override).',
    );
  });

  it('displays adaptive thinking without effort', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue({ mode: 'adaptive' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: adaptive (group override).',
    );
  });

  it('displays enabled thinking without budget', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi.fn().mockReturnValue({ mode: 'enabled' }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: enabled (group override).',
    );
  });

  it('displays enabled thinking with budget tokens', async () => {
    const deps = makeDeps({
      getGroupThinkingOverride: vi
        .fn()
        .mockReturnValue({ mode: 'enabled', budgetTokens: 8192 }),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: enabled (budget 8192 tokens) (group override).',
    );
  });

  it('displays thinking set with disabled mode', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking off')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to disabled for this group.',
    );
  });

  it('displays thinking set with enabled mode', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking enabled')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to enabled for this group.',
    );
  });

  it('displays thinking set with enabled mode and budget', async () => {
    const deps = makeDeps();
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking enabled 4096')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Thinking set to enabled (budget 4096 tokens) for this group.',
    );
  });

  it('displays unknown thinking mode via fallback (describeThinking line 84)', async () => {
    // Covers line 84: return value.mode for unknown modes
    const deps = makeDeps({
      getGroupThinkingOverride: vi
        .fn()
        .mockReturnValue({ mode: 'streaming' } as any),
    });
    const result = await handleSessionCommand({
      missedMessages: [makeMsg('/thinking')],
      groupName: 'test',
      triggerPattern: trigger,
      timezone: 'UTC',
      deps,
    });
    expect(result).toEqual({ handled: true, success: true });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'Current thinking: streaming (group override).',
    );
  });
});
