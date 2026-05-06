import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { NewMessage, ConversationRoute } from '@core/domain/types.js';
import {
  decodeGroupMessageCursor,
  encodeGroupMessageCursor,
} from '@core/shared/message-cursor.js';
import type { AgentOutput } from '@core/runtime/agent-spawn-types.js';
import type { GroupProcessingDeps } from '@core/runtime/group-processing-types.js';
import { PartialMessageDeliveryError } from '@core/runtime/partial-delivery.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@core/config/index.js', () => ({
  ASSISTANT_NAME: 'Andy',
  IDLE_TIMEOUT: 1_800_000,
  MEMORY_MAINTENANCE_MAX_PENDING: 5_000,
  MAX_MESSAGES_PER_PROMPT: 50,
  CHROME_PATH: undefined,
  TIMEZONE: 'UTC',
  getDefaultModelConfig: () => ({ model: undefined }),
  getTriggerPattern: (trigger?: string) =>
    trigger ? new RegExp(`^@${trigger}\\b`, 'i') : /^@Andy\b/i,
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockRunDreamingSweep = vi.fn();
const mockGetMemoryStatus = vi.fn();
const mockSaveProcedure = vi.fn();
const mockBuildBrief = vi.fn();
vi.mock('@core/memory/app-memory-service.js', () => ({
  AppMemoryService: {
    getInstance: () => ({
      triggerDreaming: (...args: unknown[]) => mockRunDreamingSweep(...args),
      list: (...args: unknown[]) => mockGetMemoryStatus(...args),
      dreamingStatus: vi.fn(async () => []),
      save: (...args: unknown[]) => mockSaveProcedure(...args),
      search: (...args: unknown[]) => mockBuildBrief(...args),
    }),
  },
}));

const mockFormatMessages = vi.fn();
const mockFormatOutboundForChannel = vi.fn();
vi.mock('@core/messaging/router.js', () => ({
  formatMessages: (...args: unknown[]) => mockFormatMessages(...args),
  formatOutboundForChannel: (...args: unknown[]) =>
    mockFormatOutboundForChannel(...args),
}));

const mockIsTriggerAllowed = vi.fn();
const mockLoadSenderAllowlist = vi.fn();
vi.mock('@core/platform/sender-allowlist.js', () => ({
  isTriggerAllowed: (...args: unknown[]) => mockIsTriggerAllowed(...args),
  loadSenderAllowlist: (...args: unknown[]) => mockLoadSenderAllowlist(...args),
}));

const mockGetAllJobs = vi.fn();
const mockGetMessagesSince = vi.fn();
const mockGetRecentJobRuns = vi.fn();
const mockListRecentJobEvents = vi.fn();
const mockSpawnAgent = vi.fn();
const mockWriteGroupsSnapshot = vi.fn();
vi.mock('@core/runtime/agent-spawn.js', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  writeGroupsSnapshot: (...args: unknown[]) => mockWriteGroupsSnapshot(...args),
}));

const mockHandleSessionCommand = vi.fn();
vi.mock('@core/session/session-commands.js', () => ({
  handleSessionCommand: (...args: unknown[]) =>
    mockHandleSessionCommand(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are declared
// ---------------------------------------------------------------------------

const { createGroupProcessor } =
  await import('@core/runtime/group-processing.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group1@g.us',
    sender: 'user1@s.whatsapp.net',
    sender_name: 'User1',
    content: 'hello',
    timestamp: '1700000001',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function makeGroup(
  overrides: Partial<ConversationRoute> = {},
): ConversationRoute {
  return {
    name: 'TestGroup',
    folder: 'test-group',
    trigger: 'Andy',
    added_at: '2024-01-01',
    requiresTrigger: true,
    isMain: false,
    ...overrides,
  };
}

type TestChannelRuntime = GroupProcessingDeps['channelRuntime'];

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeChannel(
  overrides: Partial<TestChannelRuntime> = {},
): TestChannelRuntime {
  const supportsStreaming =
    overrides.supportsStreaming ??
    (Object.prototype.hasOwnProperty.call(overrides, 'sendStreamingChunk')
      ? vi.fn().mockReturnValue(true)
      : vi.fn().mockReturnValue(false));
  const supportsProgress =
    overrides.supportsProgress ??
    (Object.prototype.hasOwnProperty.call(overrides, 'sendProgressUpdate')
      ? vi.fn().mockReturnValue(true)
      : vi.fn().mockReturnValue(false));
  return {
    hasChannel: vi.fn().mockReturnValue(true),
    supportsStreaming,
    supportsProgress,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendStreamingChunk: vi.fn().mockResolvedValue(undefined),
    resetStreaming: vi.fn(),
    setTyping: vi.fn().mockResolvedValue(undefined),
    sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<GroupProcessingDeps> = {},
): GroupProcessingDeps {
  const opsRepository = {
    getAllJobs: (...args: unknown[]) => mockGetAllJobs(...args),
    getMessagesSince: (...args: unknown[]) => mockGetMessagesSince(...args),
    getRecentJobRuns: (...args: unknown[]) => mockGetRecentJobRuns(...args),
    listRecentJobEvents: (...args: unknown[]) =>
      mockListRecentJobEvents(...args),
    getAllChats: vi.fn().mockResolvedValue([]),
    expireProviderSession: vi.fn(),
    setSession: vi.fn(),
  } as unknown as GroupProcessingDeps['opsRepository'];

  return {
    channelRuntime: makeChannel(),
    getGroup: vi.fn().mockReturnValue(undefined),
    clearSession: vi.fn(),
    getCursor: vi.fn().mockReturnValue('0'),
    setCursor: vi.fn(),
    saveState: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    collectSessionMemory: vi.fn().mockResolvedValue({ saved: 0 }),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    getRegisteredJids: vi.fn().mockReturnValue(new Set<string>()),
    opsRepository,
    queue: {
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      registerProcess: vi.fn(),
    },
    ...overrides,
  };
}

/**
 * Configure a standard "happy path" set of mocks that processes messages
 * through to agent spawn. Returns the deps and channel for further assertions.
 */
function setupHappyPath(
  opts: {
    group?: ConversationRoute;
    messages?: NewMessage[];
    agentOutput?: AgentOutput;
  } = {},
) {
  const group = opts.group ?? makeGroup({ isMain: true });
  const channel = makeChannel();
  const messages = opts.messages ?? [makeMessage()];
  const agentOutput: AgentOutput = opts.agentOutput ?? {
    status: 'success',
    result: 'Agent reply text',
  };

  const deps = makeDeps({
    channelRuntime: channel,
    getGroup: vi.fn().mockReturnValue(group),
  });
  mockGetMessagesSince.mockReturnValue(messages);
  mockHandleSessionCommand.mockResolvedValue({ handled: false });
  mockFormatMessages.mockReturnValue('formatted prompt');
  mockFormatOutboundForChannel.mockImplementation((raw: string) =>
    raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim(),
  );
  mockGetAllJobs.mockReturnValue([]);
  mockGetRecentJobRuns.mockReturnValue([]);
  mockListRecentJobEvents.mockReturnValue([]);
  mockRunDreamingSweep.mockResolvedValue({
    promotedCount: 0,
    decayedCount: 0,
    retiredCount: 0,
  });
  mockBuildBrief.mockResolvedValue([]);
  mockGetMemoryStatus.mockResolvedValue([]);
  mockSaveProcedure.mockReturnValue({ id: 'proc-1' });
  mockLoadSenderAllowlist.mockReturnValue({});
  mockIsTriggerAllowed.mockReturnValue(true);

  // spawnAgent: by default calls onOutput with a successful result then returns it
  mockSpawnAgent.mockImplementation(
    async (
      _group: ConversationRoute,
      _input: unknown,
      _onProc: unknown,
      onOutput?: (output: AgentOutput) => Promise<void>,
    ) => {
      if (onOutput) await onOutput(agentOutput);
      return agentOutput;
    },
  );

  return { deps, channel, group, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createGroupProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =======================================================================
  // Early returns
  // =======================================================================

  describe('early returns', () => {
    it('returns true when group is not found', async () => {
      const deps = makeDeps({ getGroup: vi.fn().mockReturnValue(undefined) });
      const { processGroupMessages } = createGroupProcessor(deps);

      const result = await processGroupMessages('unknown@g.us');

      expect(result).toBe(true);
      expect(deps.channelRuntime.hasChannel).not.toHaveBeenCalled();
    });

    it('returns true when channel is not found for the JID', async () => {
      const group = makeGroup();
      const deps = makeDeps({
        channelRuntime: makeChannel({
          hasChannel: vi.fn().mockReturnValue(false),
        }),
        getGroup: vi.fn().mockReturnValue(group),
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
    });

    it('returns true when there are no missed messages', async () => {
      const channel = makeChannel();
      const group = makeGroup();
      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
      });
      mockGetMessagesSince.mockReturnValue([]);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Session command delegation
  // =======================================================================

  describe('session command handling', () => {
    it('delegates to handleSessionCommand and returns success when handled', async () => {
      const { deps } = setupHappyPath();
      mockHandleSessionCommand.mockResolvedValue({
        handled: true,
        success: true,
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('delegates to handleSessionCommand and returns false when handled but failed', async () => {
      const { deps } = setupHappyPath();
      mockHandleSessionCommand.mockResolvedValue({
        handled: true,
        success: false,
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(false);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('continues processing when session command is not handled', async () => {
      const { deps } = setupHappyPath();
      mockHandleSessionCommand.mockResolvedValue({ handled: false });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Trigger pattern gating for non-main groups
  // =======================================================================

  describe('trigger pattern filtering (non-main groups)', () => {
    it('returns true without processing when non-main group has no trigger in messages', async () => {
      const group = makeGroup({
        isMain: false,
        requiresTrigger: true,
        trigger: 'Andy',
      });
      const messages = [makeMessage({ content: 'hello there' })];
      const { deps } = setupHappyPath({ group, messages });
      mockIsTriggerAllowed.mockReturnValue(true);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('processes messages when non-main group has trigger in messages', async () => {
      const group = makeGroup({
        isMain: false,
        requiresTrigger: true,
        trigger: 'Andy',
      });
      const messages = [makeMessage({ content: '@Andy please help' })];
      const { deps } = setupHappyPath({ group, messages });
      mockIsTriggerAllowed.mockReturnValue(true);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('skips trigger check for main groups', async () => {
      const group = makeGroup({ isMain: true, requiresTrigger: true });
      const messages = [makeMessage({ content: 'no trigger here' })];
      const { deps } = setupHappyPath({ group, messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('skips trigger check when requiresTrigger is false', async () => {
      const group = makeGroup({ isMain: false, requiresTrigger: false });
      const messages = [makeMessage({ content: 'no trigger here' })];
      const { deps } = setupHappyPath({ group, messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('allows trigger from own messages (is_from_me)', async () => {
      const group = makeGroup({
        isMain: false,
        requiresTrigger: true,
        trigger: 'Andy',
      });
      const messages = [
        makeMessage({ content: '@Andy do this', is_from_me: true }),
      ];
      const { deps } = setupHappyPath({ group, messages });
      // isTriggerAllowed does NOT need to pass for is_from_me messages
      mockIsTriggerAllowed.mockReturnValue(false);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('blocks trigger from non-allowlisted sender', async () => {
      const group = makeGroup({
        isMain: false,
        requiresTrigger: true,
        trigger: 'Andy',
      });
      const messages = [
        makeMessage({ content: '@Andy do this', is_from_me: false }),
      ];
      const { deps } = setupHappyPath({ group, messages });
      mockIsTriggerAllowed.mockReturnValue(false);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Successful agent run
  // =======================================================================

  describe('successful agent run', () => {
    it('advances cursor to last message timestamp', async () => {
      const messages = [
        makeMessage({ timestamp: '1700000001' }),
        makeMessage({ timestamp: '1700000005', id: 'msg-2' }),
      ];
      const { deps } = setupHappyPath({ messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Cursor set to last message timestamp
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(setCursorCalls).toHaveLength(1);
      expect(setCursorCalls[0][0]).toBe('group1@g.us');
      expect(decodeGroupMessageCursor(setCursorCalls[0][1])).toEqual({
        timestamp: '1700000005',
        id: 'msg-2',
      });
      expect(deps.saveState).toHaveBeenCalled();
    });

    it('returns true on successful agent run', async () => {
      const { deps } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
    });

    it('sends agent output to channel with internal tags stripped', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'Hello <internal>secret stuff</internal> world',
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Hello  world',
      );
    });

    it('sends fallback notice when agent output is fully internal', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: '<internal>all internal</internal>',
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'I finished that run but did not generate a user-visible reply. Please send your message again.',
      );
    });

    it('calls setTyping true before and false after agent run', async () => {
      const { deps, channel } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const typingCalls = (channel.setTyping as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(typingCalls[0]).toEqual(['group1@g.us', true]);
      expect(typingCalls[typingCalls.length - 1]).toEqual([
        'group1@g.us',
        false,
      ]);
    });

    it('notifies idle without closing stdin on final success marker from onOutput callback', async () => {
      const { deps } = setupHappyPath();
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _prompt: string,
          _chatJid: string,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'partial reply' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.queue.notifyIdle).toHaveBeenCalledWith('group1@g.us');
      expect(deps.queue.closeStdin).not.toHaveBeenCalled();
    });

    it('clears typing at a live stream turn boundary before the runner exits', async () => {
      const liveRun = deferred<AgentOutput>();
      const typingStopped = deferred();
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
        setTyping: vi.fn(async (_chatJid: string, isTyping: boolean) => {
          if (!isTyping) typingStopped.resolve();
        }),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = channel;
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'partial reply' });
          await onOutput?.({ status: 'success', result: null });
          return liveRun.promise;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us');
      await typingStopped.promise;

      expect(deps.queue.notifyIdle).toHaveBeenCalledWith('group1@g.us');
      expect(channel.setTyping).toHaveBeenLastCalledWith('group1@g.us', false);
      expect(channel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        expect.stringMatching(/^Done in /),
        { done: true, replaceOnly: true },
      );

      liveRun.resolve({ status: 'success', result: null });
      await processing;
    });

    it('drains unawaited output callbacks before clearing typing and marking idle', async () => {
      const sendStarted = deferred();
      const sendReleased = deferred();
      const channel = makeChannel({
        sendMessage: vi.fn(async () => {
          sendStarted.resolve();
          await sendReleased.promise;
        }),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = channel;
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          void onOutput?.({ status: 'success', result: 'late reply' });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us');
      await sendStarted.promise;

      expect(
        (channel.setTyping as ReturnType<typeof vi.fn>).mock.calls,
      ).not.toContainEqual(['group1@g.us', false]);
      expect(deps.queue.notifyIdle).not.toHaveBeenCalled();

      sendReleased.resolve();
      await processing;

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'late reply',
      );
      expect(deps.queue.notifyIdle).toHaveBeenCalledWith('group1@g.us');
      const sendOrder = (channel.sendMessage as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const typingFalseOrder = (
        channel.setTyping as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder.at(-1);
      expect(sendOrder).toBeLessThan(typingFalseOrder ?? 0);
      expect(
        (channel.setTyping as ReturnType<typeof vi.fn>).mock.calls.at(-1),
      ).toEqual(['group1@g.us', false]);
    });

    it('does not write group capability snapshots on the message hot path', async () => {
      const { deps } = setupHappyPath();
      mockGetAllJobs.mockReturnValue([]);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockGetAllJobs).not.toHaveBeenCalled();
      expect(mockGetRecentJobRuns).not.toHaveBeenCalled();
      expect(mockListRecentJobEvents).not.toHaveBeenCalled();
      expect(mockWriteGroupsSnapshot).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Agent error scenarios
  // =======================================================================

  describe('agent error with no output sent', () => {
    it('rolls back cursor and returns false', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps } = setupHappyPath({ group, messages });

      // Return error with NO result (no output sent to user)
      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'boom',
      };
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue(
        'prev-cursor',
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(false);
      // cursor should be rolled back to the previous value
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .calls;
      const lastSetCursor = setCursorCalls[setCursorCalls.length - 1];
      expect(lastSetCursor).toEqual(['group1@g.us', 'prev-cursor']);
    });
  });

  describe('agent error AFTER output was sent to user', () => {
    it('does NOT roll back cursor and returns true (prevents duplicates)', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps, channel } = setupHappyPath({ group, messages });

      // Simulate: first call has result text, second call signals error
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          // First output chunk with actual text (will trigger sendMessage)
          if (onOutput) {
            await onOutput({ status: 'success', result: 'Partial response' });
          }
          // Then signal error
          if (onOutput) {
            await onOutput({
              status: 'error',
              result: null,
              error: 'late error',
            });
          }
          return {
            status: 'error',
            result: null,
            error: 'late error',
          } as AgentOutput;
        },
      );

      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue(
        'prev-cursor',
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      // Output was sent
      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Partial response',
      );

      // Cursor should NOT be rolled back: the last setCursor should be the advance, not a rollback
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .calls;
      // First call advances cursor to message timestamp; there should be no second rollback call
      expect(setCursorCalls).toHaveLength(1);
      expect(setCursorCalls[0][0]).toBe('group1@g.us');
      expect(decodeGroupMessageCursor(setCursorCalls[0][1])).toEqual({
        timestamp: '1700000001',
        id: 'msg-1',
      });
    });

    it('treats partial channel delivery as output sent and avoids cursor rollback', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps, channel } = setupHappyPath({ group, messages });
      const partialDeliveryError = new PartialMessageDeliveryError({
        cause: new Error('network failure on second chunk'),
        deliveredChunks: 1,
        message: 'one Telegram chunk was delivered before failure',
        name: 'PartialTelegramDeliveryError',
        totalChunks: 2,
      });

      (channel.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        partialDeliveryError,
      );
      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue(
        'prev-cursor',
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Agent reply text',
      );
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(setCursorCalls).toHaveLength(1);
      expect(decodeGroupMessageCursor(setCursorCalls[0][1])).toEqual({
        timestamp: '1700000001',
        id: 'msg-1',
      });
    });
  });

  describe('agent spawn throws exception', () => {
    it('rolls back cursor and returns false when spawnAgent throws', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps } = setupHappyPath({ group, messages });

      mockSpawnAgent.mockRejectedValue(new Error('spawn failed'));
      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue(
        'prev-cursor',
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      // runAgent catches the error and returns 'error', no output was sent
      expect(result).toBe(false);
    });
  });

  // =======================================================================
  // Postgres-authoritative session context
  // =======================================================================

  describe('Postgres-authoritative session context', () => {
    it('passes hydrated memory context and provider session resume id', async () => {
      const group = makeGroup({ isMain: true });
      const { deps } = setupHappyPath({ group });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          providerSessionId: 'provider-session:1',
          externalSessionId: 'claude-session-1',
          memoryContextBlock:
            '<myclaw_memory_context>memory</myclaw_memory_context>',
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        sessionId: 'claude-session-1',
        memoryContextBlock: expect.stringContaining(
          '<myclaw_memory_context>memory</myclaw_memory_context>',
        ),
      });
      expect(mockSpawnAgent.mock.calls[0][4]).toBeUndefined();
    });

    it('persists SDK session ids from final agent output for the next turn', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'response',
        newSessionId: 'new-sess-123',
      };
      const group = makeGroup({ isMain: true });
      const { deps } = setupHappyPath({ group, agentOutput });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.opsRepository.setSession).toHaveBeenCalledWith(
        group.folder,
        'new-sess-123',
        null,
        { conversationJid: 'group1@g.us' },
      );
    });

    it('persists SDK session ids from streamed output before the runner exits', async () => {
      const group = makeGroup({ isMain: true });
      const { deps } = setupHappyPath({ group });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });
      const streamed = deferred<void>();
      const releaseRunner = deferred<AgentOutput>();

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) {
            await onOutput({
              status: 'success',
              result: 'text',
              newSessionId: 'streamed-sess',
            });
          }
          streamed.resolve();
          return releaseRunner.promise;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us');
      await streamed.promise;

      expect(deps.opsRepository.setSession).toHaveBeenCalledWith(
        group.folder,
        'streamed-sess',
        null,
        { conversationJid: 'group1@g.us' },
      );

      releaseRunner.resolve({ status: 'success', result: 'text' });
      await processing;
    });
  });

  // =======================================================================
  // Idle timeout behavior
  // =======================================================================

  describe('idle timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('closes stdin after IDLE_TIMEOUT ms when agent produces output', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });

      // Make spawnAgent call onOutput then wait, so the idle timer can fire
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) {
            await onOutput({ status: 'success', result: 'hello' });
          }
          // Simulate agent waiting (idle timeout should fire during this)
          await vi.advanceTimersByTimeAsync(1_800_000);
          return { status: 'success', result: 'hello' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.queue.closeStdin).toHaveBeenCalledWith('group1@g.us');
    });

    it('clears idle timer after agent completes', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });

      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'fast reply',
      };
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(agentOutput);
          return agentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Now advance timers well past IDLE_TIMEOUT — closeStdin should NOT be called
      // because the timer was cleared after the agent finished
      (deps.queue.closeStdin as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(2_000_000);

      expect(deps.queue.closeStdin).not.toHaveBeenCalled();
    });

    it('keeps typing heartbeat alive and posts elapsed progress for long runs', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime = channel;

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          _onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await vi.advanceTimersByTimeAsync(125_000);
          return { status: 'success', result: 'done' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(
        (channel.setTyping as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThan(3);
      expect(channel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Working on it...',
      );
      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            call[0] === 'group1@g.us' &&
            typeof call[1] === 'string' &&
            call[1].startsWith('Still working ('),
        ),
      ).toBe(true);
      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            call[0] === 'group1@g.us' &&
            typeof call[1] === 'string' &&
            call[1].startsWith('Done in ') &&
            call[2]?.done === true,
        ),
      ).toBe(true);
    });

    it('posts no-output warning for long silent runs without auto-failing', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime = channel;

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          _onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await vi.advanceTimersByTimeAsync(190_000);
          return { status: 'success', result: 'done' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const ok = await processGroupMessages('group1@g.us');

      expect(ok).toBe(true);
      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            call[0] === 'group1@g.us' &&
            typeof call[1] === 'string' &&
            call[1].startsWith('No new output yet, still running'),
        ),
      ).toBe(true);
    });
  });

  // =======================================================================
  // Output result handling details
  // =======================================================================

  describe('output handling', () => {
    it('finalizes streaming once when agent only emits text output', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'stream text' });
          return { status: 'success', result: 'stream text' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(streamingChannel.sendStreamingChunk).toHaveBeenCalledTimes(2);
      const firstCallGeneration = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[2]?.generation;
      expect(streamingChannel.sendStreamingChunk).toHaveBeenNthCalledWith(
        1,
        'group1@g.us',
        'stream text',
        expect.objectContaining({ generation: expect.any(Number) }),
      );
      expect(streamingChannel.sendStreamingChunk).toHaveBeenNthCalledWith(
        2,
        'group1@g.us',
        '',
        expect.objectContaining({
          done: true,
          generation: firstCallGeneration,
        }),
      );
    });

    it('advances streaming generation for each completed live SDK turn', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'first turn' });
          await onOutput?.({ status: 'success', result: null });
          await onOutput?.({ status: 'success', result: 'second turn' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const calls = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(calls).toHaveLength(4);
      const firstGeneration = calls[0]?.[2]?.generation;
      const secondGeneration = calls[2]?.[2]?.generation;
      expect(firstGeneration).toEqual(expect.any(Number));
      expect(secondGeneration).toEqual(expect.any(Number));
      expect(secondGeneration).toBeGreaterThan(firstGeneration);
      expect(calls[0]).toEqual([
        'group1@g.us',
        'first turn',
        expect.objectContaining({ generation: firstGeneration }),
      ]);
      expect(calls[1]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: firstGeneration }),
      ]);
      expect(calls[2]).toEqual([
        'group1@g.us',
        'second turn',
        expect.objectContaining({ generation: secondGeneration }),
      ]);
      expect(calls[3]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: secondGeneration }),
      ]);
      expect(deps.queue.notifyIdle).toHaveBeenCalledTimes(2);
    });

    it('does not treat compact boundary markers as turn completion', async () => {
      const { deps } = setupHappyPath();
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            result: null,
            compactBoundary: true,
          });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.collectSessionMemory).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:1',
        trigger: 'precompact',
        defaultScope: 'group',
      });
      expect(deps.queue.notifyIdle).not.toHaveBeenCalled();
    });

    it('splits streaming messages around user interaction boundaries', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(undefined),
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'before approval' });
          await onOutput?.({
            status: 'success',
            result: null,
            interactionBoundary: 'user_interaction',
          });
          await onOutput?.({ status: 'success', result: 'after approval' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const calls = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(calls).toHaveLength(4);
      const beforeGeneration = calls[0]?.[2]?.generation;
      const afterGeneration = calls[2]?.[2]?.generation;
      expect(afterGeneration).toBeGreaterThan(beforeGeneration);
      expect(calls[0]).toEqual([
        'group1@g.us',
        'before approval',
        expect.objectContaining({ generation: beforeGeneration }),
      ]);
      expect(calls[1]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: beforeGeneration }),
      ]);
      expect(streamingChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Waiting for your input.',
        { replaceOnly: true },
      );
      expect(calls[2]).toEqual([
        'group1@g.us',
        'after approval',
        expect.objectContaining({ generation: afterGeneration }),
      ]);
      expect(calls[3]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: afterGeneration }),
      ]);
      expect(deps.queue.notifyIdle).toHaveBeenCalledTimes(1);
    });

    it('persists delivered streaming output as canonical assistant context', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;
      (deps.opsRepository as any).storeMessage = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          memoryContextBlock:
            '<myclaw_memory_context>memory</myclaw_memory_context>',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('run-1');
      (deps.opsRepository as any).completeSessionAgentRun = vi.fn();

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'stream text' });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.opsRepository.storeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chat_jid: 'group1@g.us',
          sender: 'myclaw',
          sender_name: 'MyClaw',
          content: 'stream text',
          is_from_me: true,
          is_bot_message: true,
          delivery_status: 'sent',
        }),
      );
      expect(deps.opsRepository.completeSessionAgentRun).toHaveBeenCalledWith({
        runId: 'run-1',
        status: 'completed',
        resultSummary: 'stream text',
      });
    });

    it('resets channel streaming state before running a new cycle', async () => {
      const resetStreaming = vi.fn();
      const streamingChannel = makeChannel({
        resetStreaming,
        sendStreamingChunk: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(resetStreaming).toHaveBeenCalledWith('group1@g.us');
    });

    it('handles non-string result by JSON.stringifying', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: JSON.stringify({ key: 'value' }),
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      // Override: spawnAgent returns object-like result that is already a string
      // The source does typeof result === 'string' check

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        '{"key":"value"}',
      );
    });

    it('does not call sendMessage when result is null', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: null,
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('strips multiple internal tags from output', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result:
          'Start <internal>tag1</internal> middle <internal>tag2\nmultiline</internal> end',
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Start  middle  end',
      );
    });

    it('does not reuse older thread context when latest message is unthreaded', async () => {
      const messages = [
        makeMessage({
          id: 'msg-older',
          timestamp: '1700000001',
          thread_id: 'old-thread',
        }),
        makeMessage({
          id: 'msg-latest',
          timestamp: '1700000002',
          thread_id: '',
        }),
      ];
      const { deps, channel } = setupHappyPath({ messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Agent reply text',
      );
      expect(
        (channel.sendMessage as ReturnType<typeof vi.fn>).mock.calls.some(
          (call: unknown[]) =>
            typeof call[2] === 'object' &&
            call[2] !== null &&
            'threadId' in (call[2] as Record<string, unknown>),
        ),
      ).toBe(false);
    });

    it('routes output to the latest message thread when latest message is threaded', async () => {
      const messages = [
        makeMessage({
          id: 'msg-older',
          timestamp: '1700000001',
          thread_id: 'old-thread',
        }),
        makeMessage({
          id: 'msg-latest',
          timestamp: '1700000002',
          thread_id: 'latest-thread',
        }),
      ];
      const { deps, channel } = setupHappyPath({ messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Agent reply text',
        { threadId: 'latest-thread' },
      );
    });

    it('uses thread queue keys to filter retrieval and bind runner context', async () => {
      const messages = [
        makeMessage({
          id: 'msg-thread',
          timestamp: '1700000001',
          thread_id: 'thread-a',
        }),
      ];
      const { deps } = setupHappyPath({ messages });
      const mockProc = {} as ChildProcess;
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          onProc: (proc: ChildProcess, containerName: string) => void,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          onProc(mockProc, 'test-container');
          if (onOutput) {
            await onOutput({ status: 'success', result: 'ok' });
          }
          return { status: 'success', result: 'ok' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us::thread:thread-a');

      expect(mockGetMessagesSince).toHaveBeenCalledWith(
        'group1@g.us',
        '0',
        50,
        { threadId: 'thread-a' },
      );
      expect(deps.queue.registerProcess).toHaveBeenCalledWith(
        'group1@g.us::thread:thread-a',
        mockProc,
        'test-container',
        'test-group',
        'group1@g.us',
        'thread-a',
      );
      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          chatJid: 'group1@g.us',
          threadId: 'thread-a',
        }),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );
      expect(mockSpawnAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
    });

    it('keeps the run thread stable without per-output storage refreshes', async () => {
      const initialMessages = [
        makeMessage({
          id: 'msg-initial',
          timestamp: '1700000001',
          thread_id: 'initial-thread',
        }),
      ];

      const { deps, channel } = setupHappyPath({ messages: initialMessages });
      mockGetMessagesSince.mockReturnValue(initialMessages);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Agent reply text',
        { threadId: 'initial-thread' },
      );
      expect(mockGetMessagesSince).toHaveBeenCalledTimes(1);
    });
  });

  // =======================================================================
  // Integration: cursor management end-to-end
  // =======================================================================

  describe('cursor management', () => {
    it('uses cursor from deps.getCursor when calling getMessagesSince', async () => {
      const group = makeGroup({ isMain: true });
      const channel = makeChannel();
      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
        getCursor: vi.fn().mockReturnValue('cursor-ts-123'),
      });
      mockGetMessagesSince.mockReturnValue([]);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockGetMessagesSince).toHaveBeenCalledWith(
        'group1@g.us',
        'cursor-ts-123',
        50,
        undefined,
      );
    });

    it('filters to unthreaded messages when invoked by the queue for a base chat', async () => {
      const { deps } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us', { queued: true });

      expect(mockGetMessagesSince).toHaveBeenCalledWith(
        'group1@g.us',
        '0',
        50,
        { threadId: null },
      );
    });

    it('saves state after advancing cursor', async () => {
      const messages = [makeMessage({ timestamp: '1700000099' })];
      const { deps } = setupHappyPath({ messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // setCursor should be called before saveState
      const setCursorOrder = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const saveStateOrder = (deps.saveState as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(setCursorOrder).toBeLessThan(saveStateOrder);
    });
  });

  // =======================================================================
  // onProcess callback passed to spawnAgent
  // =======================================================================

  describe('process registration', () => {
    it('passes registerProcess callback to spawnAgent', async () => {
      const group = makeGroup({ isMain: true });
      const { deps } = setupHappyPath({ group });

      const mockProc = {} as ChildProcess;
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          onProc: (proc: ChildProcess, containerName: string) => void,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          onProc(mockProc, 'test-container');
          if (onOutput) {
            await onOutput({ status: 'success', result: 'ok' });
          }
          return { status: 'success', result: 'ok' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.queue.registerProcess).toHaveBeenCalledWith(
        'group1@g.us',
        mockProc,
        'test-container',
        'test-group',
        undefined,
        undefined,
      );
    });
  });

  // =======================================================================
  // Agent input construction
  // =======================================================================

  describe('agent input construction', () => {
    it('passes correct input fields to spawnAgent', async () => {
      const group = makeGroup({
        isMain: true,
        folder: 'my-group',
        agentConfig: { thinking: { mode: 'adaptive' } },
      });
      const { deps } = setupHappyPath({ group });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        group,
        expect.objectContaining({
          prompt: 'formatted prompt',
          groupFolder: 'my-group',
          chatJid: 'group1@g.us',
          isMain: true,
          assistantName: 'Andy',
          thinking: { mode: 'adaptive' },
        }),
        expect.any(Function), // onProcess
        expect.any(Function), // onOutput
        undefined, // options
      );
      expect(mockSpawnAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
    });
  });

  // =======================================================================
  // handleSessionCommand deps (closure) coverage
  // =======================================================================

  describe('handleSessionCommand deps closures', () => {
    /**
     * Helper: calls processGroupMessages with a mock handleSessionCommand that
     * captures the `deps` object it receives, then returns { handled: true, success: true }.
     * Returns the captured deps for the test to exercise individual closures.
     */
    async function captureSessionDeps(
      opts: {
        group?: ConversationRoute;
        messages?: NewMessage[];
        queueJid?: string;
      } = {},
    ) {
      const group =
        opts.group ?? makeGroup({ isMain: true, folder: 'grp-folder' });
      const channel = makeChannel();
      const messages = opts.messages ?? [makeMessage()];

      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
      });
      mockGetMessagesSince.mockReturnValue(messages);
      mockLoadSenderAllowlist.mockReturnValue({});
      mockIsTriggerAllowed.mockReturnValue(true);

      let capturedDeps: Record<string, unknown> = {};
      mockHandleSessionCommand.mockImplementation(
        async (arg: { deps: Record<string, unknown> }) => {
          capturedDeps = arg.deps;
          return { handled: true, success: true };
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages(opts.queueJid ?? 'group1@g.us');

      return { capturedDeps, deps, channel, group };
    }

    it('sendMessage delegates to channel.sendMessage with the chatJid', async () => {
      const { capturedDeps, channel } = await captureSessionDeps();
      const sendMessage = capturedDeps.sendMessage as (
        text: string,
      ) => Promise<void>;

      await sendMessage('hello from session cmd');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'hello from session cmd',
      );
    });

    it('setTyping delegates to channel.setTyping', async () => {
      const { capturedDeps, channel } = await captureSessionDeps();
      const setTyping = capturedDeps.setTyping as (
        typing: boolean,
      ) => Promise<void>;

      await setTyping(true);

      expect(channel.setTyping).toHaveBeenCalledWith('group1@g.us', true);
    });

    it('closeStdin delegates to deps.queue.closeStdin', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const closeStdin = capturedDeps.closeStdin as () => void;

      closeStdin();

      expect(deps.queue.closeStdin).toHaveBeenCalledWith('group1@g.us');
    });

    it('advanceCursor sets cursor and saves state', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const advanceCursor = capturedDeps.advanceCursor as (
        message: Pick<NewMessage, 'timestamp' | 'id'>,
      ) => void;

      advanceCursor({ timestamp: '1700099999', id: 'msg-advance' });

      expect(deps.setCursor).toHaveBeenCalledWith(
        'group1@g.us',
        encodeGroupMessageCursor({
          timestamp: '1700099999',
          id: 'msg-advance',
        }),
      );
      expect(deps.saveState).toHaveBeenCalled();
    });

    it('advanceCursor catches saveState rejection', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      (deps.saveState as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('state write failed'),
      );
      const advanceCursor = capturedDeps.advanceCursor as (
        message: Pick<NewMessage, 'timestamp' | 'id'>,
      ) => void;

      advanceCursor({ timestamp: '1700099999', id: 'msg-advance' });
      await Promise.resolve();

      expect(deps.saveState).toHaveBeenCalled();
      expect(deps.setCursor).toHaveBeenCalledWith(
        'group1@g.us',
        expect.any(String),
      );
    });

    it('getDefaultModel returns model from config', async () => {
      const { capturedDeps } = await captureSessionDeps();
      const getDefaultModel = capturedDeps.getDefaultModel as () =>
        | string
        | undefined;

      expect(getDefaultModel()).toBeUndefined();
    });

    it('getGroupModelOverride returns the group agentConfig.model', async () => {
      const group = makeGroup({ isMain: true, agentConfig: { model: 'opus' } });
      const { capturedDeps } = await captureSessionDeps({ group });
      const getGroupModelOverride = capturedDeps.getGroupModelOverride as () =>
        | string
        | undefined;

      expect(getGroupModelOverride()).toBe('opus');
    });

    it('setGroupModelOverride delegates to deps', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const setGroupModelOverride = capturedDeps.setGroupModelOverride as (
        v: string | undefined,
      ) => void;

      setGroupModelOverride('sonnet');

      expect(deps.setGroupModelOverride).toHaveBeenCalledWith(
        'group1@g.us',
        'sonnet',
      );
    });

    it('getGroupThinkingOverride returns the group agentConfig.thinking', async () => {
      const group = makeGroup({
        isMain: true,
        agentConfig: { thinking: { mode: 'enabled' } },
      });
      const { capturedDeps } = await captureSessionDeps({ group });
      const getGroupThinkingOverride =
        capturedDeps.getGroupThinkingOverride as () => unknown;

      expect(getGroupThinkingOverride()).toEqual({ mode: 'enabled' });
    });

    it('setGroupThinkingOverride delegates to deps', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const setGroupThinkingOverride =
        capturedDeps.setGroupThinkingOverride as (v: unknown) => void;

      setGroupThinkingOverride({ mode: 'disabled' });

      expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(
        'group1@g.us',
        { mode: 'disabled' },
      );
    });

    it('saveProcedure carries active thread scope into memory writes', async () => {
      const { capturedDeps } = await captureSessionDeps({
        messages: [
          makeMessage({
            id: 'thread-save-procedure',
            thread_id: 'thread-procedure',
          }),
        ],
        queueJid: 'group1@g.us::thread:thread-procedure',
      });
      const saveProcedure = capturedDeps.saveProcedure as (input: {
        title: string;
        body: string;
      }) => Promise<unknown>;

      await saveProcedure({ title: 'Deploy flow', body: '1. Build\n2. Ship' });

      expect(mockSaveProcedure).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: 'thread-procedure',
          key: 'procedure:Deploy flow',
          value: '1. Build\n2. Ship',
        }),
      );
    });

    it('archiveCurrentSession does not archive provider transcripts', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const archiveCurrentSession = capturedDeps.archiveCurrentSession as (
        cause?: 'new-session' | 'manual-compact',
      ) => Promise<void>;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:test',
        });

      await archiveCurrentSession('new-session');

      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalled();
      expect(deps.collectSessionMemory).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:test',
        trigger: 'session-end',
        defaultScope: 'group',
      });
    });

    it('archiveCurrentSession collects precompact memory without checkpointing summary for /compact', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const archiveCurrentSession = capturedDeps.archiveCurrentSession as (
        cause?: 'new-session' | 'manual-compact',
      ) => Promise<void>;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:test',
        });

      await archiveCurrentSession('manual-compact');

      expect(deps.collectSessionMemory).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:test',
        trigger: 'precompact',
        defaultScope: 'group',
      });
    });

    it('archiveCurrentSession does nothing when no session', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const archiveCurrentSession =
        capturedDeps.archiveCurrentSession as () => Promise<void>;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);

      await archiveCurrentSession();

      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalled();
      expect(deps.collectSessionMemory).not.toHaveBeenCalled();
    });

    it('clearCurrentSession clears session and deletes from DB', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const clearCurrentSession =
        capturedDeps.clearCurrentSession as () => Promise<void> | void;

      await clearCurrentSession();

      expect(deps.clearSession).toHaveBeenCalledWith('grp-folder', undefined);
    });

    describe('canSenderInteract', () => {
      it('returns true for main group regardless of trigger', async () => {
        const group = makeGroup({ isMain: true });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;

        const msg = makeMessage({ content: 'no trigger' });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for non-main group with requiresTrigger=false', async () => {
        const group = makeGroup({ isMain: false, requiresTrigger: false });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;

        const msg = makeMessage({ content: 'no trigger' });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for non-main group when trigger present and is_from_me', async () => {
        const group = makeGroup({
          isMain: false,
          requiresTrigger: true,
          trigger: 'Andy',
        });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;

        const msg = makeMessage({ content: '@Andy hello', is_from_me: true });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for non-main group when trigger present and sender is allowlisted', async () => {
        const group = makeGroup({
          isMain: false,
          requiresTrigger: true,
          trigger: 'Andy',
        });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;
        mockIsTriggerAllowed.mockReturnValue(true);

        const msg = makeMessage({ content: '@Andy hello', is_from_me: false });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns false for non-main group when trigger present but sender not allowed', async () => {
        const group = makeGroup({
          isMain: false,
          requiresTrigger: true,
          trigger: 'Andy',
        });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;
        mockIsTriggerAllowed.mockReturnValue(false);

        const msg = makeMessage({ content: '@Andy hello', is_from_me: false });
        expect(canSenderInteract(msg)).toBe(false);
      });

      it('returns false for non-main group when no trigger in message', async () => {
        const group = makeGroup({
          isMain: false,
          requiresTrigger: true,
          trigger: 'Andy',
        });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;

        const msg = makeMessage({
          content: 'just chatting',
          is_from_me: false,
        });
        expect(canSenderInteract(msg)).toBe(false);
      });
    });

    it('runAgent delegates to the internal runAgent function', async () => {
      const group = makeGroup({ isMain: true, folder: 'grp-folder' });
      const channel = makeChannel();
      const messages = [makeMessage()];

      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
      });
      mockGetMessagesSince.mockReturnValue(messages);
      mockGetAllJobs.mockReturnValue([]);
      mockGetRecentJobRuns.mockReturnValue([]);
      mockLoadSenderAllowlist.mockReturnValue({});

      let capturedRunAgent: (
        prompt: string,
        onOutput?: (output: AgentOutput) => Promise<void>,
        options?: { timeoutMs?: number },
      ) => Promise<'success' | 'error'>;

      mockHandleSessionCommand.mockImplementation(
        async (arg: { deps: Record<string, unknown> }) => {
          capturedRunAgent = arg.deps.runAgent as typeof capturedRunAgent;
          return { handled: true, success: true };
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Now invoke the captured runAgent
      mockSpawnAgent.mockResolvedValue({
        status: 'success',
        result: 'ok',
      } as AgentOutput);

      const result = await capturedRunAgent!('test prompt');
      expect(result).toBe('success');
      expect(mockSpawnAgent).toHaveBeenCalledWith(
        group,
        expect.objectContaining({ prompt: 'test prompt' }),
        expect.any(Function),
        undefined,
        undefined,
      );
    });

    it('runAgent collects memory when SDK auto-compacts', async () => {
      const group = makeGroup({ isMain: true, folder: 'grp-folder' });
      const channel = makeChannel();
      const messages = [makeMessage()];
      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
      });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:test',
        });
      mockGetMessagesSince.mockReturnValue(messages);
      mockGetAllJobs.mockReturnValue([]);
      mockGetRecentJobRuns.mockReturnValue([]);
      mockLoadSenderAllowlist.mockReturnValue({});

      let capturedRunAgent: (
        prompt: string,
        onOutput?: (output: AgentOutput) => Promise<void>,
      ) => Promise<'success' | 'error'>;
      mockHandleSessionCommand.mockImplementation(
        async (arg: { deps: Record<string, unknown> }) => {
          capturedRunAgent = arg.deps.runAgent as typeof capturedRunAgent;
          return { handled: true, success: true };
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      mockSpawnAgent.mockImplementation(
        async (_group, _input, _register, onOutput) => {
          await onOutput?.({
            status: 'success',
            result: null,
            compactBoundary: true,
          });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      await capturedRunAgent!('test prompt', vi.fn());

      expect(deps.collectSessionMemory).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:test',
        trigger: 'precompact',
        defaultScope: 'group',
      });
    });
  });

  // =========================================================================
  // Bug-hunting: adversarial edge cases
  // =========================================================================

  describe('stale session set from errored agent run', () => {
    it('should not set session ID when agent returns error status', async () => {
      const group = makeGroup({ isMain: true });
      const channel = makeChannel();
      const messages = [makeMessage()];

      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
        getCursor: vi.fn().mockReturnValue('0'),
      });
      mockGetMessagesSince.mockReturnValue(messages);
      mockHandleSessionCommand.mockResolvedValue({ handled: false });
      mockFormatMessages.mockReturnValue('formatted prompt');
      mockGetAllJobs.mockReturnValue([]);
      mockGetRecentJobRuns.mockReturnValue([]);
      mockLoadSenderAllowlist.mockReturnValue({});

      // Agent returns error WITH a newSessionId
      mockSpawnAgent.mockImplementation(
        async (
          _group: unknown,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          const errorOutput: AgentOutput = {
            status: 'error',
            result: null,
            error: 'something broke',
            newSessionId: 'broken-session-123',
          };
          await onOutput?.(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.opsRepository.setSession).not.toHaveBeenCalled();
    });
  });

  describe('double setSession from streamed + final output', () => {
    it('persists a streamed SDK session ID once even when final output repeats it', async () => {
      const group = makeGroup({ isMain: true });
      const channel = makeChannel();
      const messages = [makeMessage()];

      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
        getCursor: vi.fn().mockReturnValue('0'),
      });
      mockGetMessagesSince.mockReturnValue(messages);
      mockHandleSessionCommand.mockResolvedValue({ handled: false });
      mockFormatMessages.mockReturnValue('formatted prompt');
      mockGetAllJobs.mockReturnValue([]);
      mockGetRecentJobRuns.mockReturnValue([]);
      mockLoadSenderAllowlist.mockReturnValue({});
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });

      mockSpawnAgent.mockImplementation(
        async (
          _group: unknown,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          const output: AgentOutput = {
            status: 'success',
            result: 'hello',
            newSessionId: 'session-42',
          };
          await onOutput?.(output);
          return output;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.opsRepository.setSession).toHaveBeenCalledTimes(1);
      expect(deps.opsRepository.setSession).toHaveBeenCalledWith(
        group.folder,
        'session-42',
        null,
        { conversationJid: 'group1@g.us' },
      );
    });
  });
});
