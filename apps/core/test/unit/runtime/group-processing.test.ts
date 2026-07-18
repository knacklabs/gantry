import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { NewMessage, ConversationRoute } from '@core/domain/types.js';
import {
  decodeGroupMessageCursor,
  encodeGroupMessageCursor,
} from '@core/shared/message-cursor.js';
import type { AgentOutput } from '@core/runtime/agent-spawn-types.js';
import type { GroupProcessingDeps } from '@core/runtime/group-processing-types.js';
import { PartialMessageDeliveryError } from '@core/domain/messages/partial-delivery.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { buildProviderSessionAccessFingerprint } from '@core/runtime/provider-session-access-fingerprint.js';
import { createAgentExecutionAdapterRegistry } from '@core/application/agent-execution/agent-execution-adapter-registry.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetRuntimeSettingsForConfig = vi.hoisted(
  () =>
    vi.fn(() => ({
      memory: {
        enabled: true,
        embeddings: {
          enabled: false,
          provider: 'disabled',
        },
      },
    })) as ReturnType<typeof vi.fn>,
);
vi.mock('@core/config/index.js', () => ({
  ASSISTANT_NAME: 'Andy',
  IDLE_TIMEOUT: 1_800_000,
  MEMORY_MAINTENANCE_MAX_PENDING: 5_000,
  MAX_MESSAGES_PER_PROMPT: 10,
  MESSAGE_FETCH_PAGE_SIZE: 50,
  TIMEZONE: 'UTC',
  getRuntimeSettingsForConfig: mockGetRuntimeSettingsForConfig,
  getDefaultModelConfig: () => ({ model: undefined }),
  getSelectedAgentHarness: () => 'auto',
  getSelectedAgentPermissionMode: (folder?: string) =>
    mockGetRuntimeSettingsForConfig().agents?.[folder ?? '']?.permissionMode ??
    'ask',
  getTriggerPattern: (trigger?: string) =>
    trigger ? new RegExp(`^@${trigger}\\b`, 'i') : /^@Andy\b/i,
}));

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  updateLogContext: vi.fn(),
}));
vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: mockLogger,
  redactString: (value: string) => value,
  withLogContext: (_context: unknown, callback: () => unknown) => callback(),
  updateLogContext: mockLogger.updateLogContext,
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
const mockFormatConversationContextMessages = vi.fn();
const mockFormatOutboundForChannel = vi.fn();
vi.mock('@core/messaging/router.js', () => ({
  formatMessages: (...args: unknown[]) => mockFormatMessages(...args),
  formatConversationContextMessages: (...args: unknown[]) =>
    mockFormatConversationContextMessages(...args),
  formatOutboundForChannel: (...args: unknown[]) =>
    mockFormatOutboundForChannel(...args),
}));

const mockIsTriggerAllowed = vi.fn();
const mockIsSenderAllowed = vi.fn();
const mockShouldDropMessage = vi.fn();
const mockShouldLogDenied = vi.fn();
const mockIsSenderControlAllowed = vi.fn();
const mockLoadSenderAllowlist = vi.fn();
const mockLoadSenderControlAllowlist = vi.fn();
vi.mock('@core/platform/sender-allowlist.js', () => ({
  isSenderAllowed: (...args: unknown[]) => mockIsSenderAllowed(...args),
  isTriggerAllowed: (...args: unknown[]) => mockIsTriggerAllowed(...args),
  isSenderControlAllowed: (...args: unknown[]) =>
    mockIsSenderControlAllowed(...args),
  shouldDropMessage: (...args: unknown[]) => mockShouldDropMessage(...args),
  shouldLogDenied: (...args: unknown[]) => mockShouldLogDenied(...args),
  loadSenderAllowlist: (...args: unknown[]) => mockLoadSenderAllowlist(...args),
  loadSenderControlAllowlist: (...args: unknown[]) =>
    mockLoadSenderControlAllowlist(...args),
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
const { RUNTIME_RESULT_SUMMARY_MAX_CHARS } =
  await import('@core/runtime/session-resume-runtime.js');
const EMPTY_ACCESS_FINGERPRINT = buildProviderSessionAccessFingerprint({});

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

function makeUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalBillableInputTokens: inputTokens,
    cacheProvider: 'none' as const,
    cacheStatus: 'unsupported' as const,
    at: new Date(0).toISOString(),
  };
}

function makePendingMessages(
  count: number,
  content: (index: number) => string,
): NewMessage[] {
  return Array.from({ length: count }, (_, index) =>
    makeMessage({
      id: String(index + 1),
      content: content(index + 1),
      timestamp: String(1_700_000_000 + index + 1),
    }),
  );
}

function mockPagedMessages(messages: NewMessage[]): void {
  let offset = 0;
  mockGetMessagesSince.mockImplementation((_chatJid, _cursor, limit = 50) => {
    const batch = messages.slice(offset, offset + Number(limit));
    offset += batch.length;
    return batch;
  });
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
    storeMessage: vi.fn().mockResolvedValue(undefined),
    getRecentTopLevelMessagesBefore: vi.fn().mockResolvedValue([]),
    getFirstThreadMessages: vi.fn().mockResolvedValue([]),
    getLatestThreadMessages: vi.fn().mockResolvedValue([]),
    expireProviderSession: vi.fn(),
    setSession: vi.fn(),
    updateAgentRunProviderMetadata: vi.fn().mockResolvedValue(undefined),
  } as unknown as GroupProcessingDeps['opsRepository'];

  return {
    channelRuntime: makeChannel(),
    getConversationRoutes: vi.fn().mockReturnValue({}),
    getGroup: vi.fn().mockReturnValue(undefined),
    clearSession: vi.fn(),
    getCursor: vi.fn().mockReturnValue('0'),
    setCursor: vi.fn(),
    saveState: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    setGroupPermissionModeOverride: vi.fn(),
    collectSessionMemory: vi.fn().mockResolvedValue({ saved: 0 }),
    executionAdapter: {
      id: 'anthropic:claude-agent-sdk',
      isMissingProviderSessionError: (error: string | undefined) =>
        /\bNo conversation found with session ID\b/i.test(error ?? ''),
      prepare: vi.fn(),
    },
    runnerSandboxProvider: {
      id: 'direct' as const,
      enforcing: false,
      start: vi.fn(),
    },
    getSelectedAgentHarness: vi.fn(() => 'auto'),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    getRegisteredJids: vi.fn().mockReturnValue(new Set<string>()),
    opsRepository,
    queue: {
      enqueueMessageCheck: vi.fn(),
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
  const group = opts.group ?? makeGroup({ requiresTrigger: false });
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
  mockFormatConversationContextMessages.mockReturnValue('formatted prompt');
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
  mockLoadSenderControlAllowlist.mockReturnValue({});
  mockIsTriggerAllowed.mockReturnValue(true);
  mockIsSenderAllowed.mockReturnValue(true);
  mockShouldDropMessage.mockReturnValue(false);
  mockShouldLogDenied.mockReturnValue(true);
  mockIsSenderControlAllowed.mockReturnValue(false);

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
    mockGetRuntimeSettingsForConfig.mockReturnValue({
      memory: {
        enabled: true,
        embeddings: { enabled: false, provider: 'disabled' },
      },
    });
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

    it('passes the agent id from an agent-qualified queue key to route lookup', async () => {
      const getGroup = vi.fn().mockReturnValue(undefined);
      const deps = makeDeps({ getGroup });
      const { processGroupMessages } = createGroupProcessor(deps);

      await processGroupMessages(
        'sl:C123::thread:1700.1::agent:agent%3Atriage',
      );

      expect(getGroup).toHaveBeenCalledWith(
        'sl:C123',
        '1700.1',
        'agent:triage',
        undefined,
      );
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

    it('requeues when a handled command fills the bounded pending replay', async () => {
      const messages = makePendingMessages(1_000, () => '/status');
      const { deps } = setupHappyPath({ messages });
      mockPagedMessages(messages);
      mockHandleSessionCommand.mockResolvedValue({
        handled: true,
        success: true,
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'group1@g.us',
      );
      expect(deps.setCursor).not.toHaveBeenCalled();
      expect(deps.saveState).not.toHaveBeenCalled();
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

    it('starts the run with the bounded pending replay and requeues when more may remain', async () => {
      const messages = makePendingMessages(
        1_001,
        (index) => `message ${index}`,
      );
      const { deps } = setupHappyPath({ messages });
      mockPagedMessages(messages);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockGetMessagesSince).toHaveBeenCalledTimes(1);
      expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
        expect.objectContaining({ currentMessages: messages.slice(0, 10) }),
        'UTC',
      );
      expect(mockSpawnAgent).toHaveBeenCalled();
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'group1@g.us',
      );
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(decodeGroupMessageCursor(setCursorCalls[0][1])).toEqual({
        timestamp: '1700000010',
        id: '10',
      });
    });
  });

  // =======================================================================
  // Trigger pattern gating
  // =======================================================================

  describe('trigger pattern filtering', () => {
    it('returns true without processing when a trigger-required conversation has no trigger in messages', async () => {
      const group = makeGroup({
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
      expect(
        (deps.opsRepository as any).getRecentTopLevelMessagesBefore,
      ).not.toHaveBeenCalled();
      expect(mockFormatConversationContextMessages).not.toHaveBeenCalled();
    });

    it('keeps requiresTrigger enforced for Telegram-style conversations before context selection', async () => {
      const group = makeGroup({
        requiresTrigger: true,
        trigger: 'Gantry',
      });
      const messages = [
        makeMessage({
          chat_jid: 'tg:-100123',
          content: 'stored Telegram topic message without trigger',
          thread_id: '42',
        }),
      ];
      const { deps } = setupHappyPath({ group, messages });
      mockIsTriggerAllowed.mockReturnValue(true);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('tg:-100123::thread:42');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
      expect(mockGetMessagesSince).toHaveBeenCalledWith('tg:-100123', '0', 50, {
        threadId: '42',
      });
      expect(
        (deps.opsRepository as any).getRecentTopLevelMessagesBefore,
      ).not.toHaveBeenCalled();
      expect(mockFormatConversationContextMessages).not.toHaveBeenCalled();
    });

    it('requeues when a no-trigger replay fills the bounded pending replay', async () => {
      const group = makeGroup({
        requiresTrigger: true,
        trigger: 'Andy',
      });
      const messages = makePendingMessages(1_000, () => 'no trigger here');
      const { deps } = setupHappyPath({ group, messages });
      mockPagedMessages(messages);
      mockIsTriggerAllowed.mockReturnValue(true);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'group1@g.us',
      );
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .calls;
      expect(setCursorCalls).toHaveLength(1);
      expect(setCursorCalls[0][0]).toBe('group1@g.us');
      expect(decodeGroupMessageCursor(setCursorCalls[0][1])).toEqual({
        timestamp: '1700000010',
        id: '10',
      });
      expect(deps.saveState).toHaveBeenCalled();
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('processes messages when a trigger-required conversation has trigger in messages', async () => {
      const group = makeGroup({
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

    it('does not bypass trigger checks for any conversation id convention', async () => {
      const group = makeGroup({ requiresTrigger: true });
      const messages = [makeMessage({ content: 'no trigger here' })];
      const { deps } = setupHappyPath({ group, messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('skips trigger check when requiresTrigger is false', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage({ content: 'no trigger here' })];
      const { deps } = setupHappyPath({ group, messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('allows trigger from own messages (is_from_me)', async () => {
      const group = makeGroup({
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
    it('terminates an inline run when accumulated usage exceeds max_run_tokens at a turn boundary', async () => {
      mockGetRuntimeSettingsForConfig.mockReturnValue({
        memory: {
          enabled: true,
          embeddings: { enabled: false, provider: 'disabled' },
        },
        agents: { 'test-group': { runtime: 'inline', maxRunTokens: 10 } },
      });
      const { deps } = setupHappyPath();
      deps.queue.stopGroup = vi.fn(() => true);
      mockSpawnAgent.mockImplementation(
        async (_group, _input, _register, onOutput) => {
          await onOutput?.({
            status: 'success',
            result: null,
            usage: makeUsage(6, 4),
            usageEventId: 'turn-1',
          });
          await onOutput?.({
            status: 'success',
            result: null,
            usage: makeUsage(6, 4),
            usageEventId: 'turn-1',
          });
          const overBudget: AgentOutput = {
            status: 'success',
            result: null,
            usage: makeUsage(1, 0),
            usageEventId: 'turn-2',
          };
          await onOutput?.(overBudget);
          return overBudget;
        },
      );

      await createGroupProcessor(deps).processGroupMessages('group1@g.us');

      expect(deps.queue.stopGroup).toHaveBeenCalledWith('group1@g.us');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          error:
            'Agent run token budget exceeded: max_run_tokens is 10; observed total is 11 tokens.',
        }),
        'Agent runner error',
      );
      expect(mockSpawnAgent).toHaveBeenCalledOnce();
    });

    it('keeps accumulated usage unlimited when max_run_tokens is unset', async () => {
      const { deps } = setupHappyPath({
        agentOutput: {
          status: 'success',
          result: 'done',
          usage: makeUsage(1_000_000, 1_000_000),
          usageEventId: 'turn-unlimited',
        },
      });
      deps.queue.stopGroup = vi.fn(() => true);

      await createGroupProcessor(deps).processGroupMessages('group1@g.us');

      expect(deps.queue.stopGroup).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('max_run_tokens'),
        }),
        'Agent runner error',
      );
    });

    it('derives the turn response schema from the drained message', async () => {
      const responseSchema = { type: 'object', required: ['answer'] };
      const { deps } = setupHappyPath({
        messages: [makeMessage({ responseSchema })],
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({ responseSchema });
    });

    it('runs multiple schema messages as separate turns', async () => {
      const firstSchema = { type: 'object', title: 'first' };
      const secondSchema = { type: 'object', title: 'second' };
      const messages = [
        makeMessage({ id: '1', timestamp: '1', content: 'plain first' }),
        makeMessage({
          id: '2',
          timestamp: '2',
          content: 'structured first',
          responseSchema: firstSchema,
        }),
        makeMessage({ id: '3', timestamp: '3', content: 'plain second' }),
        makeMessage({
          id: '4',
          timestamp: '4',
          content: 'structured second',
          responseSchema: secondSchema,
        }),
      ];
      const { deps } = setupHappyPath({ messages });
      let cursor = '0';
      deps.getCursor = vi.fn(() => cursor);
      deps.setCursor = vi.fn((_queueJid, nextCursor) => {
        cursor = nextCursor;
      });
      mockGetMessagesSince.mockImplementation((_jid, cursor) => {
        const afterTimestamp = decodeGroupMessageCursor(
          String(cursor),
        ).timestamp;
        return messages.filter(
          (message) => Number(message.timestamp) > Number(afterTimestamp),
        );
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');
      await processGroupMessages('group1@g.us');

      expect(
        mockSpawnAgent.mock.calls.map((call) => call[1].responseSchema),
      ).toEqual([firstSchema, secondSchema]);
      expect(
        mockFormatConversationContextMessages.mock.calls.map((call) =>
          call[0].currentMessages.map((message: NewMessage) => message.id),
        ),
      ).toEqual([
        ['1', '2'],
        ['3', '4'],
      ]);
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'group1@g.us',
      );
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    });

    it('ends a turn at the first schema message and drains trailing plain messages', async () => {
      const responseSchema = { type: 'object', title: 'structured' };
      const messages = [
        makeMessage({ id: '1', timestamp: '1', content: 'plain first' }),
        makeMessage({
          id: '2',
          timestamp: '2',
          content: 'structured',
          responseSchema,
        }),
        makeMessage({ id: '3', timestamp: '3', content: 'plain follow-up' }),
      ];
      const { deps } = setupHappyPath({ messages });
      let cursor = '0';
      deps.getCursor = vi.fn(() => cursor);
      deps.setCursor = vi.fn((_queueJid, nextCursor) => {
        cursor = nextCursor;
      });
      mockGetMessagesSince.mockImplementation((_jid, cursor) => {
        const afterTimestamp = decodeGroupMessageCursor(
          String(cursor),
        ).timestamp;
        return messages.filter(
          (message) => Number(message.timestamp) > Number(afterTimestamp),
        );
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');
      await processGroupMessages('group1@g.us');

      expect(
        mockSpawnAgent.mock.calls.map((call) => call[1].responseSchema),
      ).toEqual([responseSchema, undefined]);
      expect(
        mockFormatConversationContextMessages.mock.calls.map((call) =>
          call[0].currentMessages.map((message: NewMessage) => message.id),
        ),
      ).toEqual([['1', '2'], ['3']]);
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledWith(
        'group1@g.us',
      );
      expect(deps.queue.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    });

    it('isolates per-request controls to one turn and threads their effective field names', async () => {
      const controls = {
        effort: 'high' as const,
        thinking: { mode: 'on' as const, budgetTokens: 2048 },
        maxOutputTokens: 4096,
      };
      const messages = [
        makeMessage({
          id: '1',
          timestamp: '1',
          content: 'controlled',
          agentControls: controls,
        }),
        makeMessage({ id: '2', timestamp: '2', content: 'plain follow-up' }),
      ];
      const { deps } = setupHappyPath({ messages });
      let cursor = '0';
      deps.getCursor = vi.fn(() => cursor);
      deps.setCursor = vi.fn((_queueJid, nextCursor) => {
        cursor = nextCursor;
      });
      mockGetMessagesSince.mockImplementation((_jid, sinceCursor) => {
        const afterTimestamp = decodeGroupMessageCursor(
          String(sinceCursor),
        ).timestamp;
        return messages.filter(
          (message) => Number(message.timestamp) > Number(afterTimestamp),
        );
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        effort: 'high',
        configuredThinking: { mode: 'on', budgetTokens: 2048 },
        maxOutputTokens: 4096,
      });
      expect(mockSpawnAgent.mock.calls[1][1].effort).toBeUndefined();
      expect(
        mockSpawnAgent.mock.calls[1][1].configuredThinking,
      ).toBeUndefined();
      expect(mockSpawnAgent.mock.calls[1][1].maxOutputTokens).toBeUndefined();
    });

    it('keeps plain message turns schema-less', async () => {
      const { deps } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent.mock.calls[0][1].responseSchema).toBeUndefined();
    });

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

    it('notifies the native message ref without sending host acknowledgement progress', async () => {
      vi.useFakeTimers();
      try {
        const runnerResult = deferred<AgentOutput>();
        const onFirstProgress = vi.fn();
        const messages = [
          makeMessage({ external_message_id: '1710000000.000100' }),
        ];
        const { deps } = setupHappyPath({ messages });
        const progressChannel = makeChannel({
          sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
        });
        deps.channelRuntime = progressChannel;
        mockSpawnAgent.mockImplementation(
          async (
            _group: ConversationRoute,
            _input: unknown,
            _onProc: unknown,
            onOutput?: (output: AgentOutput) => Promise<void>,
          ) => {
            const output = await runnerResult.promise;
            await onOutput?.(output);
            return output;
          },
        );

        const { processGroupMessages } = createGroupProcessor(deps);
        const processing = processGroupMessages('group1@g.us', {
          onFirstProgress,
        });

        runnerResult.resolve({ status: 'success', result: 'done' });
        await processing;
        expect(onFirstProgress).toHaveBeenCalledTimes(1);
        expect(onFirstProgress).toHaveBeenCalledWith({
          jid: 'group1@g.us',
          messageRef: '1710000000.000100',
        });
        expect(progressChannel.sendProgressUpdate).not.toHaveBeenCalledWith(
          'group1@g.us',
          '⏳ Working',
          expect.anything(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends an immediate control-only Stop affordance without host acknowledgement copy', async () => {
      const runnerResult = deferred<AgentOutput>();
      const onFirstProgress = vi.fn();
      const messages = [
        makeMessage({ external_message_id: '1710000000.000200' }),
      ];
      const { deps } = setupHappyPath({ messages });
      const progressChannel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      deps.channelRuntime = progressChannel;
      mockSpawnAgent.mockImplementation(async () => runnerResult.promise);

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us', {
        onFirstProgress,
      });

      await vi.waitFor(() => {
        expect(progressChannel.sendProgressUpdate).toHaveBeenCalledWith(
          'group1@g.us',
          '',
          expect.objectContaining({
            actionOnly: true,
            actionAffordances: [
              expect.objectContaining({
                kind: 'live_turn_stop',
                label: 'Stop',
                actionToken: expect.any(String),
              }),
            ],
          }),
        );
      });
      expect(onFirstProgress).toHaveBeenCalledWith({
        jid: 'group1@g.us',
        messageRef: '1710000000.000200',
      });

      runnerResult.resolve({ status: 'success', result: 'done' });
      await processing;
      const doneProgress = (
        progressChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.find((call) => call[1] === 'Done.');
      expect(doneProgress?.[2]).toEqual(
        expect.objectContaining({ done: true }),
      );
      expect(doneProgress?.[2]).not.toHaveProperty('actionAffordances');
    });

    it('registers the live Stop token before rendering the Stop affordance', async () => {
      const order: string[] = [];
      const runnerResult = deferred<AgentOutput>();
      const onLiveStopActionToken = vi.fn(async () => {
        order.push('token');
      });
      const { deps } = setupHappyPath();
      const progressChannel = makeChannel({
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          if (text === '') order.push('progress');
        }),
      });
      deps.channelRuntime = progressChannel;
      mockSpawnAgent.mockImplementation(async () => runnerResult.promise);

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us', {
        onLiveStopActionToken,
      });

      await vi.waitFor(() => {
        expect(progressChannel.sendProgressUpdate).toHaveBeenCalledWith(
          'group1@g.us',
          '',
          expect.objectContaining({
            actionOnly: true,
            actionAffordances: [
              expect.objectContaining({
                kind: 'live_turn_stop',
                label: 'Stop',
                actionToken: expect.any(String),
              }),
            ],
          }),
        );
      });
      const progressCall = (
        progressChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.find((call) => call[1] === '');
      const actionToken =
        progressCall?.[2]?.actionAffordances?.[0]?.actionToken;
      expect(onLiveStopActionToken).toHaveBeenCalledWith(actionToken);
      expect(order.slice(0, 2)).toEqual(['token', 'progress']);

      runnerResult.resolve({ status: 'success', result: 'done' });
      await processing;
    });

    it('settles initial Stop affordance before sending terminal progress', async () => {
      const runnerResult = deferred<AgentOutput>();
      const stopProgressSettled = deferred<void>();
      const { deps } = setupHappyPath();
      const progressChannel = makeChannel({
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          if (text === '') await stopProgressSettled.promise;
        }),
      });
      deps.channelRuntime = progressChannel;
      mockSpawnAgent.mockImplementation(async () => runnerResult.promise);

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us');

      await vi.waitFor(() => {
        expect(progressChannel.sendProgressUpdate).toHaveBeenCalledWith(
          'group1@g.us',
          '',
          expect.objectContaining({ actionOnly: true }),
        );
      });
      runnerResult.resolve({ status: 'success', result: 'done' });
      await Promise.resolve();
      expect(
        (progressChannel.sendProgressUpdate as ReturnType<typeof vi.fn>).mock
          .calls,
      ).not.toContainEqual([
        'group1@g.us',
        'Done.',
        expect.objectContaining({ done: true }),
      ]);

      stopProgressSettled.resolve();
      await processing;
      expect(progressChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Done.',
        expect.objectContaining({ done: true }),
      );
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

    it('sends done progress at a terminal marker while keeping the runner active', async () => {
      const liveRun = deferred<AgentOutput>();
      const terminalMarkerHandled = deferred();
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
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
          terminalMarkerHandled.resolve();
          return liveRun.promise;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us');
      await terminalMarkerHandled.promise;

      expect(deps.queue.notifyIdle).not.toHaveBeenCalled();
      expect(deps.queue.closeStdin).not.toHaveBeenCalled();
      expect(channel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Done.',
        expect.objectContaining({ done: true }),
      );
      expect(channel.setTyping).toHaveBeenLastCalledWith('group1@g.us', false);
      const doneCallsAtMarker = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[1] === 'Done.');
      expect(doneCallsAtMarker).toHaveLength(1);

      liveRun.resolve({ status: 'success', result: null });
      await processing;
      expect(deps.queue.notifyIdle).toHaveBeenCalledWith('group1@g.us');
      expect(deps.queue.closeStdin).not.toHaveBeenCalled();
      expect(channel.setTyping).toHaveBeenLastCalledWith('group1@g.us', false);
      const doneCalls = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[1] === 'Done.');
      expect(doneCalls).toHaveLength(1);
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
      const group = makeGroup({ requiresTrigger: false });
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

    it('delivers the last response_schema candidate from structured failure metadata', async () => {
      const candidate = '{"wrong":"last"}';
      const { deps, channel } = setupHappyPath({
        agentOutput: {
          status: 'error',
          result: candidate,
          error: 'Inline response failed response_schema validation',
          failure: {
            type: 'execution',
            attemptedAction: 'Validate inline response against response_schema',
            partialResult: candidate,
          },
        },
      });

      const { processGroupMessages } = createGroupProcessor(deps);

      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        candidate,
      );
    });

    it('publishes normalized model usage with the resolved model fields', async () => {
      const usage = {
        ...makeUsage(12, 4),
        model: 'sonnet',
        provider: 'test-provider',
      };
      const publishRuntimeEvent = vi.fn().mockResolvedValue(undefined);
      const { deps } = setupHappyPath({
        agentOutput: {
          status: 'success',
          result: 'done',
          usage,
          usageEventId: 'usage-event-1',
        },
      });
      deps.publishRuntimeEvent = publishRuntimeEvent;

      const { processGroupMessages } = createGroupProcessor(deps);

      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: RUNTIME_EVENT_TYPES.MODEL_USAGE,
          payload: {
            usage,
            usageEventId: 'usage-event-1',
            modelAlias: 'sonnet',
            providerId: 'test-provider',
          },
        }),
      );
    });

    it('delivers output when normalized model usage preparation fails', async () => {
      const usage = makeUsage(12, 4);
      Object.defineProperty(usage, 'model', {
        get: () => {
          throw new Error('usage model unavailable');
        },
      });
      const { deps, channel } = setupHappyPath({
        agentOutput: {
          status: 'success',
          result: 'done',
          usage,
        },
      });

      const { processGroupMessages } = createGroupProcessor(deps);

      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);
      expect(channel.sendMessage).toHaveBeenCalledWith('group1@g.us', 'done');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          group: 'TestGroup',
        }),
        'Failed to prepare normalized model usage runtime event',
      );
    });

    it('delivers output when normalized model usage publication fails', async () => {
      const publishRuntimeEvent = vi
        .fn()
        .mockRejectedValue(new Error('usage event insert failed'));
      const { deps, channel } = setupHappyPath({
        agentOutput: {
          status: 'success',
          result: 'done',
          usage: {
            ...makeUsage(12, 4),
            model: 'sonnet',
            provider: 'test-provider',
          },
        },
      });
      deps.publishRuntimeEvent = publishRuntimeEvent;

      const { processGroupMessages } = createGroupProcessor(deps);

      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);
      expect(channel.sendMessage).toHaveBeenCalledWith('group1@g.us', 'done');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.any(Error),
          group: 'TestGroup',
        }),
        'Failed to publish normalized model usage runtime event',
      );
    });

    it('publishes terminal runner runtime events on error', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const publishRuntimeEvent = vi.fn().mockResolvedValue(undefined);
      const { deps } = setupHappyPath({ group, messages });
      deps.publishRuntimeEvent = publishRuntimeEvent;

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'Sandbox runtime startup failed',
        runtimeEvents: [
          {
            appId: 'app-one',
            agentId: 'agent-one',
            runId: 'run-one',
            conversationId: 'group1@g.us',
            eventType: 'sandbox.blocked',
            payload: { phase: 'startup' },
          },
        ],
      };
      mockSpawnAgent.mockResolvedValue(errorOutput);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(false);
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'app-one',
          agentId: 'agent-one',
          runId: 'run-one',
          conversationId: 'group1@g.us',
          eventType: 'sandbox.blocked',
          actor: 'runner',
          responseMode: 'none',
          payload: { phase: 'startup' },
        }),
      );
    });

    it('does not dedupe string and object runtime event payloads together', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const publishRuntimeEvent = vi.fn().mockResolvedValue(undefined);
      const { deps } = setupHappyPath({ group, messages });
      deps.publishRuntimeEvent = publishRuntimeEvent;

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'Sandbox runtime startup failed',
        runtimeEvents: [
          {
            appId: 'app-one',
            agentId: 'agent-one',
            runId: 'run-one',
            conversationId: 'group1@g.us',
            eventType: 'sandbox.blocked',
            payload: '{}',
          },
          {
            appId: 'app-one',
            agentId: 'agent-one',
            runId: 'run-one',
            conversationId: 'group1@g.us',
            eventType: 'sandbox.blocked',
            payload: {},
          },
        ],
      };
      mockSpawnAgent.mockResolvedValue(errorOutput);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(false);
      expect(publishRuntimeEvent).toHaveBeenCalledTimes(2);
    });

    it('does not fail the turn for non-JSON runtime event payloads', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const publishRuntimeEvent = vi.fn().mockResolvedValue(undefined);
      const { deps } = setupHappyPath({ group, messages });
      deps.publishRuntimeEvent = publishRuntimeEvent;

      const successOutput: AgentOutput = {
        status: 'success',
        result: 'done',
        runtimeEvents: [
          {
            appId: 'app-one',
            agentId: 'agent-one',
            runId: 'run-one',
            conversationId: 'group1@g.us',
            eventType: 'sandbox.blocked',
            payload: 1n,
          },
        ],
      };
      mockSpawnAgent.mockResolvedValue(successOutput);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(publishRuntimeEvent).toHaveBeenCalledWith(
        expect.objectContaining({ payload: 1n }),
      );
    });

    it('does not retry Model Access authentication failures', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps, channel } = setupHappyPath({ group, messages });

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error:
          'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
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

      expect(result).toBe(true);
      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Model Access authentication failed. Update the provider API key in Model Access, then send the message again.',
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

  describe('agent error AFTER output was sent to user', () => {
    it('does NOT roll back cursor and returns true (prevents duplicates)', async () => {
      const group = makeGroup({ requiresTrigger: false });
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

    it('treats partial channel delivery as output sent, avoids rollback, and replaces completion with delivery-incomplete', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime = channel;
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
      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            call[0] === 'group1@g.us' &&
            call[1] === 'I hit an issue.' &&
            call[2]?.done === true,
        ),
      ).toBe(true);
    });
  });

  describe('agent spawn throws exception', () => {
    it('rolls back cursor and returns false when spawnAgent throws', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps } = setupHappyPath({ group, messages });

      mockSpawnAgent.mockRejectedValue(new Error('spawn failed'));
      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue(
        'prev-cursor',
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      // runAgent catches the error and returns 'error', no output was sent.
      expect(result).toBe(false);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'TestGroup',
          err: expect.objectContaining({
            message: 'spawn failed',
          }),
        }),
        'Agent error',
      );
    });
  });

  // =======================================================================
  // Postgres-authoritative session context
  // =======================================================================

  describe('Postgres-authoritative session context', () => {
    it('passes hydrated memory context with provider session resume id', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const { deps } = setupHappyPath({ group });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          providerSessionId: 'provider-session:1',
          externalSessionId: 'claude-session-1',
          providerSessionAccessFingerprint: EMPTY_ACCESS_FINGERPRINT,
          memoryContextBlock:
            '<gantry_memory_context>memory</gantry_memory_context>',
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({
          agentFolder: group.folder,
          conversationJid: 'group1@g.us',
          query: 'hello',
        }),
      );
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        memoryContextBlock: expect.stringContaining(
          '<gantry_memory_context>memory</gantry_memory_context>',
        ),
        sessionId: 'claude-session-1',
      });
      expect(mockSpawnAgent.mock.calls[0][4]).toMatchObject({
        executionAdapter: expect.objectContaining({
          id: 'anthropic:claude-agent-sdk',
        }),
      });
    });

    // Proactive surfacing is fail-closed at the runner callsite: it only reads
    // pattern candidates when the agent is unlocked AND the conversation has an
    // enabled opt-in row. These tests pin every fail-closed branch.
    function setupProactiveSurfacingCase(opts: {
      optIn?: { proactiveSurfacingEnabled: boolean } | null;
      getBySubject?: () => Promise<{
        proactiveSurfacingEnabled: boolean;
      } | null>;
    }) {
      const group = makeGroup({
        requiresTrigger: false,
        folder: 'lead-agent',
        conversationKind: 'channel',
      });
      const patternCandidateRepository = {
        listEligible: vi.fn(async () => []),
      };
      const getBySubject =
        opts.getBySubject ?? vi.fn(async () => opts.optIn ?? null);
      const { deps } = setupHappyPath({ group });
      deps.getAgentLockStatus = vi.fn(() => {
        try {
          const settings = mockGetRuntimeSettingsForConfig();
          return settings.agents?.['lead-agent']?.accessPreset === 'locked'
            ? 'locked'
            : 'full';
        } catch {
          return 'unknown';
        }
      });
      deps.getPatternCandidateRepository = vi.fn(
        () => patternCandidateRepository as never,
      );
      deps.getProactiveSurfacingRepository = vi.fn(
        () => ({ getBySubject }) as never,
      );
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'default',
          agentId: 'agent:lead-agent',
          agentSessionId: 'agent-session:1',
          providerSessionAccessFingerprint: EMPTY_ACCESS_FINGERPRINT,
          memoryContextBlock:
            '<gantry_memory_context>memory</gantry_memory_context>',
        });
      return { deps, patternCandidateRepository, getBySubject };
    }

    it('reads channel pattern candidates with the resolved memory agent id when opted in', async () => {
      const { deps, patternCandidateRepository } = setupProactiveSurfacingCase({
        optIn: { proactiveSurfacingEnabled: true },
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us', {
        memoryContext: { userId: 'user-1', source: 'message' },
      });

      expect(patternCandidateRepository.listEligible).toHaveBeenCalledWith({
        subject: {
          appId: 'default',
          agentId: 'agent:lead-agent',
          folder: 'lead-agent',
          subjectType: 'channel',
          subjectId: 'conversation:group1@g.us',
        },
        limit: 1,
      });
    });

    it('does not surface patterns when there is no opt-in row', async () => {
      const { deps, patternCandidateRepository } = setupProactiveSurfacingCase({
        optIn: null,
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us', {
        memoryContext: { userId: 'user-1', source: 'message' },
      });

      expect(patternCandidateRepository.listEligible).not.toHaveBeenCalled();
    });

    it('does not surface patterns when the conversation has opted out', async () => {
      const { deps, patternCandidateRepository } = setupProactiveSurfacingCase({
        optIn: { proactiveSurfacingEnabled: false },
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us', {
        memoryContext: { userId: 'user-1', source: 'message' },
      });

      expect(patternCandidateRepository.listEligible).not.toHaveBeenCalled();
    });

    it('does not surface patterns when the agent access is locked', async () => {
      mockGetRuntimeSettingsForConfig.mockReturnValue({
        memory: {
          enabled: true,
          embeddings: { enabled: false, provider: 'disabled' },
        },
        agents: { 'lead-agent': { accessPreset: 'locked' } },
      } as never);
      const { deps, patternCandidateRepository, getBySubject } =
        setupProactiveSurfacingCase({
          optIn: { proactiveSurfacingEnabled: true },
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us', {
        memoryContext: { userId: 'user-1', source: 'message' },
      });

      // Locked short-circuits before the consent read and the candidate read.
      expect(getBySubject).not.toHaveBeenCalled();
      expect(patternCandidateRepository.listEligible).not.toHaveBeenCalled();
    });

    it('does not surface patterns when the agent lock status is unknown', async () => {
      mockGetRuntimeSettingsForConfig.mockImplementation(() => {
        throw new Error('settings unavailable');
      });
      const { deps, patternCandidateRepository, getBySubject } =
        setupProactiveSurfacingCase({
          optIn: { proactiveSurfacingEnabled: true },
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await expect(
        processGroupMessages('group1@g.us', {
          memoryContext: { userId: 'user-1', source: 'message' },
        }),
      ).resolves.not.toThrow();

      expect(getBySubject).not.toHaveBeenCalled();
      expect(patternCandidateRepository.listEligible).not.toHaveBeenCalled();
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('does not surface patterns and does not throw when the consent read fails', async () => {
      const { deps, patternCandidateRepository } = setupProactiveSurfacingCase({
        getBySubject: vi.fn(async () => {
          throw new Error('consent store unavailable');
        }),
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      // The turn must still proceed (no throw) and the agent must still spawn.
      await expect(
        processGroupMessages('group1@g.us', {
          memoryContext: { userId: 'user-1', source: 'message' },
        }),
      ).resolves.not.toThrow();

      expect(patternCandidateRepository.listEligible).not.toHaveBeenCalled();
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('adds selected skill metadata to runtime context without injecting full skill bodies', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const skillRepository = {
        getSkill: vi.fn(async () => ({
          id: 'skill:release-writer',
          appId: 'app:test',
          agentId: 'agent:test',
          name: 'release-writer',
          description: 'Use for drafting release notes.',
          source: 'admin_uploaded',
          status: 'installed',
          promptRefs: [],
          toolIds: [],
          workflowRefs: [],
          storage: {
            storageType: 'local-filesystem',
            storageRef: 'skills/release-writer',
            contentHash: 'sha256-release-writer',
            sizeBytes: 1024,
          },
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        })),
        listAgentSkillBindings: vi.fn(async () => [
          {
            id: 'binding:release-writer',
            appId: 'app:test',
            agentId: 'agent:test',
            skillId: 'skill:release-writer',
            status: 'active',
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ]),
        listEnabledSkillsForAgent: vi.fn(async () => [
          {
            id: 'skill:release-writer',
            appId: 'app:test',
            agentId: 'agent:test',
            name: 'release-writer',
            description: 'Use for drafting release notes.',
            source: 'admin_uploaded',
            status: 'installed',
            promptRefs: [],
            toolIds: [],
            workflowRefs: [],
            storage: {
              storageType: 'local-filesystem',
              storageRef: 'skills/release-writer',
              contentHash: 'sha256-release-writer',
              sizeBytes: 1024,
            },
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        ]),
      };
      const skillArtifactStore = {
        getSkillArtifact: vi.fn(async () => ({
          assets: [
            {
              path: 'SKILL.md',
              content: Buffer.from(
                [
                  '---',
                  'name: release-writer',
                  'description: Use for drafting release notes.',
                  '---',
                  '# Release Writer',
                  'FULL BODY INSTRUCTIONS MUST NOT BE INJECTED',
                ].join('\n'),
              ),
            },
          ],
        })),
      };
      const { deps } = setupHappyPath({ group });
      deps.getSkillRepository = vi.fn(() => skillRepository as never);
      deps.getSkillArtifactStore = vi.fn(() => skillArtifactStore as never);
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          providerSessionId: 'provider-session:1',
          externalSessionId: 'claude-session-1',
          providerSessionAccessFingerprint: EMPTY_ACCESS_FINGERPRINT,
          memoryContextBlock:
            '<gantry_memory_context>memory</gantry_memory_context>',
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const memoryContextBlock = mockSpawnAgent.mock.calls[0][1]
        .memoryContextBlock as string;
      expect(skillRepository.listEnabledSkillsForAgent).toHaveBeenCalledWith({
        appId: 'app:test',
        agentId: 'agent:test',
      });
      expect(skillArtifactStore.getSkillArtifact).not.toHaveBeenCalled();
      expect(memoryContextBlock).toContain(
        '<gantry_memory_context>memory</gantry_memory_context>',
      );
      expect(memoryContextBlock).toContain(
        'release-writer (skill:release-writer)',
      );
      expect(memoryContextBlock).toContain('revision: sha256-release-writer');
      expect(memoryContextBlock).not.toContain('```markdown');
      expect(memoryContextBlock).not.toContain(
        'FULL BODY INSTRUCTIONS MUST NOT BE INJECTED',
      );
    });

    it('expires provider session resume when runtime access projection changes', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'fresh reply',
        newSessionId: 'claude-session-fresh',
      };
      const group = makeGroup({ requiresTrigger: false });
      const { deps } = setupHappyPath({ group, agentOutput });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          providerSessionId: 'provider-session:old',
          externalSessionId: 'claude-session-old',
          providerSessionAccessFingerprint: 'provider-session-access:v1:stale',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:message-1');

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.opsRepository.expireProviderSession).toHaveBeenCalledWith({
        providerSessionId: 'provider-session:old',
        agentSessionId: 'agent-session:1',
        provider: 'anthropic:claude-agent-sdk',
        externalSessionId: 'claude-session-old',
      });
      expect(mockSpawnAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
      expect(deps.opsRepository.createSessionAgentRun).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:1',
        executionProviderId: 'anthropic:claude-agent-sdk',
        providerSessionId: undefined,
        cause: 'message',
      });
      expect(deps.opsRepository.setSession).toHaveBeenCalledWith(
        group.folder,
        'claude-session-fresh',
        null,
        expect.objectContaining({
          expectedAgentSessionId: 'agent-session:1',
          accessFingerprint: expect.stringMatching(
            /^provider-session-access:v1:/,
          ),
        }),
      );
    });

    it('expires a missing provider session and retries the turn without resume', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const { deps, channel } = setupHappyPath({ group });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          providerSessionId: 'provider-session:1',
          externalSessionId: 'claude-session-stale',
          providerSessionAccessFingerprint: EMPTY_ACCESS_FINGERPRINT,
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:message-1');

      mockSpawnAgent.mockImplementationOnce(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          const output: AgentOutput = {
            status: 'error',
            result: null,
            error: 'No conversation found with session ID: stale',
          };
          await onOutput?.(output);
          return output;
        },
      );
      mockSpawnAgent.mockImplementationOnce(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          const output: AgentOutput = {
            status: 'success',
            result: 'fresh reply',
            newSessionId: 'claude-session-fresh',
          };
          await onOutput?.(output);
          return output;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);

      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        sessionId: 'claude-session-stale',
      });
      expect(mockSpawnAgent.mock.calls[1][1]).not.toHaveProperty('sessionId');
      expect(deps.opsRepository.expireProviderSession).toHaveBeenCalledWith({
        providerSessionId: 'provider-session:1',
        agentSessionId: 'agent-session:1',
        provider: 'anthropic:claude-agent-sdk',
        externalSessionId: 'claude-session-stale',
      });
      expect(
        deps.opsRepository.updateAgentRunProviderMetadata,
      ).toHaveBeenCalledWith({
        runId: 'agent-run:message-1',
        providerSessionId: null,
      });
      expect(deps.opsRepository.setSession).toHaveBeenCalledWith(
        group.folder,
        'claude-session-fresh',
        null,
        expect.objectContaining({
          expectedAgentSessionId: 'agent-session:1',
        }),
      );
      const progressTexts = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.map((call) => call[1]);
      expect(progressTexts).not.toContain('I hit an issue.');
    });

    it('uses the selected execution adapter to classify missing provider sessions', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const otherAdapter = {
        id: 'test:other-agent-sdk',
        isMissingProviderSessionError: vi.fn(() => false),
        prepare: vi.fn(),
      };
      const selectedAdapter = {
        id: 'anthropic:claude-agent-sdk',
        isMissingProviderSessionError: vi.fn((error: string | undefined) =>
          /\bNo conversation found with session ID\b/i.test(error ?? ''),
        ),
        prepare: vi.fn(),
      };
      const { deps } = setupHappyPath({ group });
      deps.executionAdapter = undefined;
      deps.executionAdapters = createAgentExecutionAdapterRegistry([
        otherAdapter,
        selectedAdapter,
      ]);
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          providerSessionId: 'provider-session:1',
          externalSessionId: 'claude-session-stale',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:message-1');

      mockSpawnAgent.mockImplementationOnce(async () => ({
        status: 'error',
        result: null,
        error: 'No conversation found with session ID: stale',
      }));
      mockSpawnAgent.mockImplementationOnce(async () => ({
        status: 'success',
        result: 'fresh reply',
        newSessionId: 'claude-session-fresh',
      }));

      const { processGroupMessages } = createGroupProcessor(deps);
      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);

      expect(
        selectedAdapter.isMissingProviderSessionError,
      ).toHaveBeenCalledWith('No conversation found with session ID: stale');
      expect(otherAdapter.isMissingProviderSessionError).not.toHaveBeenCalled();
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
      expect(deps.opsRepository.expireProviderSession).toHaveBeenCalledWith({
        providerSessionId: 'provider-session:1',
        agentSessionId: 'agent-session:1',
        provider: 'anthropic:claude-agent-sdk',
        externalSessionId: 'claude-session-stale',
      });
    });

    it('falls back to runtime missing-session patterns when an adapter returns false', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const selectedAdapter = {
        id: 'anthropic:claude-agent-sdk',
        isMissingProviderSessionError: vi.fn(() => false),
        prepare: vi.fn(),
      };
      const { deps } = setupHappyPath({ group });
      deps.executionAdapter = undefined;
      deps.executionAdapters = createAgentExecutionAdapterRegistry([
        selectedAdapter,
      ]);
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          providerSessionId: 'provider-session:1',
          externalSessionId: 'deepagents-session-stale',
          providerSessionAccessFingerprint: EMPTY_ACCESS_FINGERPRINT,
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:message-1');

      mockSpawnAgent.mockImplementationOnce(async () => ({
        status: 'error',
        result: null,
        error:
          'No DeepAgents session found with session ID: deepagents-session-stale',
      }));
      mockSpawnAgent.mockImplementationOnce(async () => ({
        status: 'success',
        result: 'fresh reply',
        newSessionId: 'deepagents-session-fresh',
      }));

      const { processGroupMessages } = createGroupProcessor(deps);
      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);

      expect(
        selectedAdapter.isMissingProviderSessionError,
      ).toHaveBeenCalledWith(
        'No DeepAgents session found with session ID: deepagents-session-stale',
      );
      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        sessionId: 'deepagents-session-stale',
      });
      expect(mockSpawnAgent.mock.calls[1][1]).not.toHaveProperty('sessionId');
      expect(deps.opsRepository.expireProviderSession).toHaveBeenCalledWith({
        providerSessionId: 'provider-session:1',
        agentSessionId: 'agent-session:1',
        provider: 'anthropic:claude-agent-sdk',
        externalSessionId: 'deepagents-session-stale',
      });
    });

    it('persists SDK session ids from final agent output for the next turn', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'response',
        newSessionId: 'new-sess-123',
      };
      const group = makeGroup({ requiresTrigger: false });
      const { deps } = setupHappyPath({ group, agentOutput });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          agentSessionResetAt: null,
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:message-1');

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.opsRepository.setSession).toHaveBeenCalledWith(
        group.folder,
        'new-sess-123',
        null,
        expect.objectContaining({
          executionProviderId: 'anthropic:claude-agent-sdk',
          conversationJid: 'group1@g.us',
          conversationKind: undefined,
          memoryUserId: 'user1@s.whatsapp.net',
          expectedAgentSessionId: 'agent-session:1',
          expectedAgentSessionResetAt: null,
        }),
      );
      expect(deps.opsRepository.createSessionAgentRun).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:1',
        executionProviderId: 'anthropic:claude-agent-sdk',
        providerSessionId: undefined,
        cause: 'message',
      });
      expect(
        deps.opsRepository.updateAgentRunProviderMetadata,
      ).toHaveBeenCalledWith({
        runId: 'agent-run:message-1',
        providerSessionId: 'new-sess-123',
      });
    });

    it('persists SDK session ids from streamed output before the runner exits', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const { deps } = setupHappyPath({ group });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          agentSessionResetAt: null,
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:streamed-1');
      const streamed = deferred<void>();
      const releaseRunner = deferred<AgentOutput>();

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          onProc: (proc: ChildProcess, runHandle: string) => void,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          onProc({} as ChildProcess, 'provider-run:streamed-1');
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
        expect.objectContaining({
          executionProviderId: 'anthropic:claude-agent-sdk',
          conversationJid: 'group1@g.us',
          conversationKind: undefined,
          memoryUserId: 'user1@s.whatsapp.net',
          expectedAgentSessionId: 'agent-session:1',
          expectedAgentSessionResetAt: null,
        }),
      );
      expect(
        deps.opsRepository.updateAgentRunProviderMetadata,
      ).toHaveBeenCalledWith({
        runId: 'agent-run:streamed-1',
        providerRunId: 'provider-run:streamed-1',
      });
      expect(
        deps.opsRepository.updateAgentRunProviderMetadata,
      ).toHaveBeenCalledWith({
        runId: 'agent-run:streamed-1',
        providerSessionId: 'streamed-sess',
      });

      releaseRunner.resolve({ status: 'success', result: 'text' });
      await processing;
    });

    it('passes direct conversation user scope when looking up turns and persisting provider sessions', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'response',
        newSessionId: 'dm-sess-123',
      };
      const group = makeGroup({
        requiresTrigger: false,
        conversationKind: 'dm',
      });
      const messages = [makeMessage({ sender: 'sl:U123', content: 'hello' })];
      const { deps } = setupHappyPath({ group, messages, agentOutput });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:dm',
          agentSessionResetAt: null,
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('sl:D123');

      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({
          agentFolder: group.folder,
          conversationJid: 'sl:D123',
          conversationKind: 'dm',
          memoryUserId: 'sl:U123',
        }),
      );
      expect(deps.opsRepository.setSession).toHaveBeenCalledWith(
        group.folder,
        'dm-sess-123',
        null,
        expect.objectContaining({
          executionProviderId: 'anthropic:claude-agent-sdk',
          conversationJid: 'sl:D123',
          conversationKind: 'dm',
          memoryUserId: 'sl:U123',
          expectedAgentSessionId: 'agent-session:dm',
          expectedAgentSessionResetAt: null,
        }),
      );
    });

    it('derives memory review approver status from canonical conversation approvers', async () => {
      const group = makeGroup({
        requiresTrigger: false,
        conversationKind: 'dm',
      });
      const messages = [
        makeMessage({
          id: 'msg-old',
          sender: 'sl:UADMIN',
          content: 'hello',
          timestamp: '1700000001',
        }),
        makeMessage({
          id: 'msg-trigger',
          sender: 'sl:UADMIN',
          content: 'list files',
          timestamp: '1700000002',
        }),
      ];
      const isControlApproverAllowed = vi.fn(async () => true);
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime.isControlApproverAllowed = isControlApproverAllowed;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentSessionId: 'agent-session:review',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:review');
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          onProc: (proc: ChildProcess, runHandle: string) => void,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          onProc({} as ChildProcess, 'provider-run:review-1');
          if (onOutput) {
            await onOutput({ status: 'success', result: 'Agent reply text' });
          }
          return { status: 'success', result: 'Agent reply text' };
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('sl:D123');

      expect(isControlApproverAllowed).toHaveBeenCalledWith({
        conversationJid: 'sl:D123',
        userId: 'sl:UADMIN',
        sourceAgentFolder: group.folder,
        decisionPolicy: 'same_channel',
      });
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        memoryReviewerIsControlApprover: true,
      });
      expect(deps.queue.registerProcess).toHaveBeenCalledWith(
        'sl:D123',
        expect.anything(),
        'provider-run:review-1',
        group.folder,
        [
          expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        ],
        undefined,
        { requiredContinuationUserId: 'sl:UADMIN' },
      );
      expect(mockIsSenderControlAllowed).not.toHaveBeenCalled();
    });

    it('does not expose memory review authority for mixed-sender turns', async () => {
      const group = makeGroup({
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const messages = [
        makeMessage({ sender: 'sl:UOTHER', content: 'approve 1' }),
        makeMessage({ sender: 'sl:UADMIN', content: 'yes' }),
      ];
      const isControlApproverAllowed = vi.fn(async () => true);
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime.isControlApproverAllowed = isControlApproverAllowed;

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('sl:C123');

      expect(isControlApproverAllowed).not.toHaveBeenCalled();
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        memoryReviewerIsControlApprover: false,
      });
    });

    it('fails memory review approver status closed when canonical lookup is unavailable', async () => {
      const group = makeGroup({
        requiresTrigger: false,
        conversationKind: 'dm',
      });
      const messages = [makeMessage({ sender: 'sl:UADMIN', content: 'hello' })];
      const { deps } = setupHappyPath({ group, messages });
      mockIsSenderControlAllowed.mockReturnValue(true);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('sl:D123');

      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        memoryReviewerIsControlApprover: false,
      });
      expect(mockIsSenderControlAllowed).not.toHaveBeenCalled();
    });

    it('caches live memory review approver checks and cached denials fail closed', async () => {
      const group = makeGroup({
        folder: 'cache-agent',
        requiresTrigger: false,
        conversationKind: 'dm',
      });
      const messages = [
        makeMessage({ sender: 'sl:UCACHE', content: 'hello cache' }),
      ];
      const isControlApproverAllowed = vi.fn(async () => false);
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime.isControlApproverAllowed = isControlApproverAllowed;

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('sl:DCACHE');
      await processGroupMessages('sl:DCACHE');

      expect(isControlApproverAllowed).toHaveBeenCalledTimes(1);
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        memoryReviewerIsControlApprover: false,
      });
      expect(mockSpawnAgent.mock.calls[1][1]).toMatchObject({
        memoryReviewerIsControlApprover: false,
      });
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

    it('closes stdin after IDLE_TIMEOUT ms even before agent output arrives', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });

      mockSpawnAgent.mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(1_800_000);
        return { status: 'success', result: null } as AgentOutput;
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.queue.closeStdin).toHaveBeenCalledWith('group1@g.us');
    });

    it('closes stdin after IDLE_TIMEOUT ms when agent produces output', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
      const group = makeGroup({ requiresTrigger: false });
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
      const group = makeGroup({ requiresTrigger: false });
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
      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            call[0] === 'group1@g.us' &&
            typeof call[1] === 'string' &&
            call[1].startsWith('⏳ Working'),
        ),
      ).toBe(false);
      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) => call[0] === 'group1@g.us' && call[1] === 'Done.',
        ),
      ).toBe(true);
    });

    it('keeps elapsed progress updating after visible output is already shown', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({
            status: 'success',
            result: 'Here are the project names.',
          });
          (channel.sendProgressUpdate as ReturnType<typeof vi.fn>).mockClear();
          await vi.advanceTimersByTimeAsync(125_000);
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            typeof call[1] === 'string' && call[1].startsWith('⏳ Working'),
        ),
      ).toBe(false);
    });

    it('does not emit host progress when a continuation starts a new visible turn', async () => {
      let continuationHandler: (() => void) | undefined;
      const run = deferred<AgentOutput>();
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage()];
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime = channel;
      deps.queue = {
        ...deps.queue,
        registerContinuationHandler: vi.fn((_queueJid, handler) => {
          continuationHandler = handler;
          return () => {
            if (continuationHandler === handler)
              continuationHandler = undefined;
          };
        }),
      };

      mockSpawnAgent.mockImplementation(async () => run.promise);

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us');
      await vi.advanceTimersByTimeAsync(20 * 60_000);

      (channel.sendProgressUpdate as ReturnType<typeof vi.fn>).mockClear();
      continuationHandler?.();
      await vi.advanceTimersByTimeAsync(65_000);

      const progressCalls = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls;
      const progressTexts = progressCalls.map((call) => String(call[1]));
      expect(
        progressCalls.some(
          (call) =>
            typeof call[1] === 'string' && call[1].startsWith('⏳ Working'),
        ),
      ).toBe(false);
      expect(progressTexts.some((text) => text.includes('20m'))).toBe(false);

      run.resolve({ status: 'success', result: null });
      await processing;
    });

    it('recreates control-only Stop affordance when a background-demoted turn resumes', async () => {
      let continuationHandler: (() => void) | undefined;
      const finishRun = deferred<void>();
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage()];
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime = channel;
      deps.queue = {
        ...deps.queue,
        registerContinuationHandler: vi.fn((_queueJid, handler) => {
          continuationHandler = handler;
          return () => {
            if (continuationHandler === handler)
              continuationHandler = undefined;
          };
        }),
      };

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
            interactionBoundary: 'user_interaction',
          });
          await finishRun.promise;
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const processing = processGroupMessages('group1@g.us');

      await vi.waitFor(() => {
        expect(channel.sendProgressUpdate).toHaveBeenCalledWith(
          'group1@g.us',
          'Waiting for your input.',
          expect.objectContaining({ replaceOnly: true }),
        );
      });
      await vi.advanceTimersByTimeAsync(121_000);
      await vi.waitFor(() => {
        expect(channel.sendProgressUpdate).toHaveBeenCalledWith(
          'group1@g.us',
          'Running in background...',
          expect.objectContaining({ done: true, replaceOnly: true }),
        );
      });

      (channel.sendProgressUpdate as ReturnType<typeof vi.fn>).mockClear();
      continuationHandler?.();

      await vi.waitFor(() => {
        expect(channel.sendProgressUpdate).toHaveBeenCalledWith(
          'group1@g.us',
          '',
          expect.objectContaining({
            actionOnly: true,
            actionAffordances: [
              expect.objectContaining({
                kind: 'live_turn_stop',
                label: 'Stop',
                actionToken: expect.any(String),
              }),
            ],
          }),
        );
      });
      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            typeof call[1] === 'string' && call[1].startsWith('⏳ Working'),
        ),
      ).toBe(false);

      finishRun.resolve();
      await processing;
    });

    it('sends done progress for each terminal-marker-delimited turn', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'first turn' });
          await onOutput?.({ status: 'success', result: null });
          await onOutput?.({ status: 'success', result: 'follow-up turn' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const progressCalls = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls;
      const indexedProgressCalls = progressCalls.map((call, index) => ({
        call,
        index,
      }));
      const doneCalls = indexedProgressCalls.filter(
        ({ call }) => call[1] === 'Done.',
      );
      expect(doneCalls).toHaveLength(2);
      expect(doneCalls[0]?.call[2]).toEqual(
        expect.objectContaining({ done: true }),
      );
      expect(doneCalls[1]?.call[2]).toEqual(
        expect.objectContaining({ done: true }),
      );
    });

    it('sends terminal progress for each completed marker inside one agent process', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'first turn' });
          await onOutput?.({ status: 'success', result: null });
          await vi.advanceTimersByTimeAsync(10 * 60_000);
          await onOutput?.({ status: 'success', result: 'second turn' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const doneProgressTexts = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls
        .map((call) => String(call[1]))
        .filter((text) => text === 'Done.');

      expect(doneProgressTexts).toHaveLength(2);
      expect(doneProgressTexts.every((text) => !text.includes('10m'))).toBe(
        true,
      );
    });

    it('does not post elapsed progress on the first heartbeat tick', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
          await vi.advanceTimersByTimeAsync(5_000);
          return { status: 'success', result: 'done' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(
        (
          channel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.some(
          (call) =>
            typeof call[1] === 'string' && call[1].startsWith('⏳ Working · '),
        ),
      ).toBe(false);
    });

    it('cancels the previous turn heartbeat when a new turn starts for the same queue', async () => {
      const firstRun = deferred<AgentOutput>();
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage()];
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime = channel;

      mockSpawnAgent
        .mockImplementationOnce(async () => firstRun.promise)
        .mockResolvedValue({ status: 'success', result: 'second done' });

      const { processGroupMessages } = createGroupProcessor(deps);
      const first = processGroupMessages('group1@g.us');
      await vi.advanceTimersByTimeAsync(1_000);
      await processGroupMessages('group1@g.us');

      const callsAfterSecondTurn = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      await vi.advanceTimersByTimeAsync(65_000);
      expect(
        (channel.sendProgressUpdate as ReturnType<typeof vi.fn>).mock.calls
          .slice(callsAfterSecondTurn)
          .some(
            (call) =>
              typeof call[1] === 'string' &&
              call[1].startsWith('⏳ Working · '),
          ),
      ).toBe(false);

      firstRun.resolve({ status: 'success', result: null });
      await first;
    });

    it('cancels initial progress before final completion on fast runs', async () => {
      const group = makeGroup({ requiresTrigger: false });
      const messages = [makeMessage()];
      const visibleProgress: string[] = [];
      const channel = makeChannel({
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          visibleProgress.push(text);
        }),
      });
      const { deps } = setupHappyPath({ group, messages });
      deps.channelRuntime = channel;

      mockSpawnAgent.mockResolvedValue({
        status: 'success',
        result: 'done',
      } satisfies AgentOutput);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(visibleProgress).not.toContain('Working on it...');
      expect(
        visibleProgress.some((item) => item.startsWith('✅ Done · ')),
      ).toBe(false);
      expect(visibleProgress).toContain('Done.');
    });

    it('posts no-output warning for long silent runs without auto-failing', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
            call[1].startsWith('⏳ Working'),
        ),
      ).toBe(false);
    });
  });

  // =======================================================================
  // Output result handling details
  // =======================================================================

  describe('output handling', () => {
    it('finalizes streaming once when agent only emits text output', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
        expect.objectContaining({
          done: false,
          generation: firstCallGeneration,
        }),
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

    it('preserves whitespace-only streaming deltas from provider output', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          for (const result of ['I', ' ', "can't", ' ', 'check']) {
            await onOutput?.({ status: 'success', result });
          }
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const chunks = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls
        .filter((call) => !call[2]?.done)
        .map((call) => call[1]);
      expect(chunks.join('')).toBe("I can't check");
    });

    it('falls back to canonical message delivery when a streaming chunk is rejected as stale', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(false),
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

      expect(streamingChannel.sendStreamingChunk).toHaveBeenCalledWith(
        'group1@g.us',
        'stream text',
        expect.objectContaining({ done: false }),
      );
      expect(streamingChannel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'stream text',
      );
    });

    it('redacts provider session handles for streaming live output delivery', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;
      const rawOutput =
        'visible-start provider-session:stream-handle claude-session-stream-handle sessionId=inline-stream {"newSessionId":"json-stream"} visible-end';

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: rawOutput });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const deliveredChunk = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls.find((call) => typeof call[1] === 'string' && call[1])?.[1];
      expect(deliveredChunk).toContain('[REDACTED]');
      expect(deliveredChunk).not.toContain('provider-session:stream-handle');
      expect(deliveredChunk).not.toContain('claude-session-stream-handle');
      expect(deliveredChunk).not.toContain('sessionId=inline-stream');
      expect(deliveredChunk).not.toContain('"newSessionId":"json-stream"');
    });

    it('does not expose split internal tags or provider handles before final streaming delivery', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await onOutput?.({
            status: 'success',
            result: 'visible <inter',
          });
          expect(streamingChannel.sendStreamingChunk).toHaveBeenCalledWith(
            'group1@g.us',
            'visible ',
            expect.objectContaining({ done: false }),
          );
          await onOutput?.({
            status: 'success',
            result: 'nal>hidden provider-session:split-handle</internal> done',
          });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(streamingChannel.sendStreamingChunk).toHaveBeenCalledTimes(3);
      const deliveredChunk = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls
        .map((call) => call[1])
        .join('');
      expect(deliveredChunk).toBe('visible  done');
      expect(deliveredChunk).not.toContain('hidden');
      expect(deliveredChunk).not.toContain('provider-session:split-handle');
    });

    it('suppresses canonical fallback sends when final streaming delivery succeeds', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(streamingChannel.sendStreamingChunk).toHaveBeenCalledWith(
        'group1@g.us',
        'stream text',
        expect.objectContaining({ done: false }),
      );
      expect(streamingChannel.sendMessage).not.toHaveBeenCalled();
    });

    it('redacts provider session handles for non-streaming live output and transcript summaries', async () => {
      const channel = makeChannel({
        supportsStreaming: vi.fn().mockReturnValue(false),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = channel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
          agentSessionResetAt: null,
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('run-1');
      (deps.opsRepository as any).completeSessionAgentRun = vi.fn();
      const rawOutput =
        'visible-start provider-session:fallback-handle claude-session-fallback-handle sessionId=fallback-inline {"newSessionId":"fallback-json"} visible-end';

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: rawOutput });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const deliveredMessage = (
        channel.sendMessage as ReturnType<typeof vi.fn>
      ).mock.calls.find((call) => call[0] === 'group1@g.us')?.[1] as
        | string
        | undefined;
      expect(deliveredMessage).toContain('[REDACTED]');
      expect(deliveredMessage).not.toContain(
        'provider-session:fallback-handle',
      );
      expect(deliveredMessage).not.toContain('claude-session-fallback-handle');
      expect(deliveredMessage).not.toContain('sessionId=fallback-inline');
      expect(deliveredMessage).not.toContain('"newSessionId":"fallback-json"');

      const completion = (deps.opsRepository as any).completeSessionAgentRun
        .mock.calls[0][0];
      const summary = completion.resultSummary as string;
      expect(summary).toContain('[REDACTED]');
      expect(summary).not.toContain('provider-session:fallback-handle');
      expect(summary).not.toContain('claude-session-fallback-handle');
      expect(summary).not.toContain('sessionId=fallback-inline');
      expect(summary).not.toContain('"newSessionId":"fallback-json"');
    });

    it('advances streaming generation for each completed live SDK turn', async () => {
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
        expect.objectContaining({ done: false, generation: firstGeneration }),
      ]);
      expect(calls[1]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: firstGeneration }),
      ]);
      expect(calls[2]).toEqual([
        'group1@g.us',
        'second turn',
        expect.objectContaining({ done: false, generation: secondGeneration }),
      ]);
      expect(calls[3]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: secondGeneration }),
      ]);
      const progressCalls = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[1] === 'Done.');
      expect(progressCalls).toHaveLength(2);
      expect(progressCalls[0]?.[2]?.done).toBe(true);
      expect(progressCalls[0]?.[2]?.generation).toBe(firstGeneration);
      expect(progressCalls[1]?.[2]?.done).toBe(true);
      expect(progressCalls[1]?.[2]?.generation).toBe(secondGeneration);
      expect(deps.queue.notifyIdle).toHaveBeenCalledTimes(1);
    });

    it('streams follow-up output without host working progress', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await onOutput?.({ status: 'success', result: 'first turn' });
          await onOutput?.({ status: 'success', result: null });
          (
            streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
          ).mockClear();

          await onOutput?.({
            status: 'success',
            result: 'follow-up turn',
          });
          expect(streamingChannel.sendProgressUpdate).not.toHaveBeenCalledWith(
            'group1@g.us',
            '⏳ Working',
            expect.anything(),
          );
          expect(streamingChannel.sendStreamingChunk).toHaveBeenCalledWith(
            'group1@g.us',
            'follow-up turn',
            expect.objectContaining({ done: false }),
          );

          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');
    });

    it('streams continuation-triggered follow-up output without host working progress', async () => {
      let continuationHandler: (() => void) | undefined;
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;
      deps.queue = {
        ...deps.queue,
        registerContinuationHandler: vi.fn((_queueJid, handler) => {
          continuationHandler = handler;
          return () => {
            if (continuationHandler === handler)
              continuationHandler = undefined;
          };
        }),
      };

      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'first turn' });
          await onOutput?.({ status: 'success', result: null });
          (
            streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
          ).mockClear();

          continuationHandler?.();
          await onOutput?.({
            status: 'success',
            result: 'follow-up turn',
          });
          expect(streamingChannel.sendProgressUpdate).not.toHaveBeenCalledWith(
            'group1@g.us',
            '⏳ Working',
            expect.anything(),
          );
          expect(streamingChannel.sendStreamingChunk).toHaveBeenCalledWith(
            'group1@g.us',
            'follow-up turn',
            expect.objectContaining({ done: false }),
          );

          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');
    });

    it('keeps buffered follow-up work in one progress lifecycle', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await onOutput?.({ status: 'success', result: 'first answer' });
          await onOutput?.({
            status: 'success',
            result: null,
            continuedByFollowup: true,
          });
          await onOutput?.({ status: 'success', result: 'follow-up answer' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const streamCalls = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls;
      const firstGeneration = streamCalls[0]?.[2]?.generation;
      const secondGeneration = streamCalls[2]?.[2]?.generation;
      expect(secondGeneration).toBeGreaterThan(firstGeneration);
      expect(streamCalls[1]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: firstGeneration }),
      ]);
      expect(streamCalls[3]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: secondGeneration }),
      ]);

      const doneProgressCalls = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[1] === 'Done.');
      expect(doneProgressCalls).toHaveLength(1);
      expect(doneProgressCalls[0]?.[2]?.done).toBe(true);
      expect(doneProgressCalls[0]?.[2]?.generation).toBe(firstGeneration);
      expect(deps.queue.notifyIdle).toHaveBeenCalledTimes(1);
    });

    it('sends final progress at the success marker generation', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await onOutput?.({ status: 'success', result: 'turn output' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const streamGeneration = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[2]?.generation;
      expect(streamGeneration).toEqual(expect.any(Number));
      const doneProgress = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.find((call) => call[1] === 'Done.');
      expect(doneProgress?.[2]?.done).toBe(true);
      expect(doneProgress?.[2]?.generation).toBe(streamGeneration);
      expect(
        (
          streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.find((call) => call[1] === 'Done.')?.[2]?.replaceOnly,
      ).toBeUndefined();
    });

    it('sends final done progress even when fast streaming skipped initial progress', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await onOutput?.({ status: 'success', result: 'fast output' });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const progressCalls = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(progressCalls.some((call) => call[1] === 'Working on it...')).toBe(
        false,
      );
      expect(progressCalls).toContainEqual([
        'group1@g.us',
        'Done.',
        expect.objectContaining({
          done: true,
          generation: expect.any(Number),
        }),
      ]);
      expect(
        progressCalls.find((call) => call[1] === 'Done.')?.[2]?.replaceOnly,
      ).toBeUndefined();
    });

    it('reports requested stops without marking progress as failed', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;

      mockSpawnAgent.mockResolvedValue({
        status: 'error',
        result: null,
        error: 'Host agent stopped by request',
      } satisfies AgentOutput);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      const progressTexts = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.map((call) => call[1]);
      expect(progressTexts).toContain('Stopped.');
      expect(progressTexts).not.toContain('I hit an issue.');
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

      expect(deps.collectSessionMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: 'agent-session:1',
          trigger: 'precompact',
          defaultScope: 'group',
          signal: expect.any(AbortSignal),
          timeoutMs: 30_000,
          statementTimeoutMs: 30_000,
        }),
      );
      expect(deps.queue.notifyIdle).not.toHaveBeenCalled();
    });

    it('starts a new content stream after user interaction boundaries', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
      expect(afterGeneration).toEqual(expect.any(Number));
      expect(afterGeneration).toBeGreaterThan(beforeGeneration);
      expect(calls[0]).toEqual([
        'group1@g.us',
        'before approval',
        expect.objectContaining({ done: false, generation: beforeGeneration }),
      ]);
      expect(streamingChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Waiting for your input.',
        expect.objectContaining({
          replaceOnly: true,
          generation: beforeGeneration,
        }),
      );
      expect(streamingChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Response received. Continuing...',
        expect.objectContaining({
          replaceOnly: true,
          generation: beforeGeneration,
        }),
      );
      expect(calls[1]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: beforeGeneration }),
      ]);
      expect(calls[2]).toEqual([
        'group1@g.us',
        'after approval',
        expect.objectContaining({ done: false, generation: afterGeneration }),
      ]);
      expect(calls[3]).toEqual([
        'group1@g.us',
        '',
        expect.objectContaining({ done: true, generation: afterGeneration }),
      ]);
      expect(deps.queue.notifyIdle).toHaveBeenCalledTimes(1);
    });

    it('does not mark progress done when a successful turn is waiting for user input', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await onOutput?.({
            status: 'success',
            result: 'Which project should this position use?',
          });
          await onOutput?.({
            status: 'success',
            result: null,
            interactionBoundary: 'user_interaction',
          });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const progressTexts = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.map((call) => call[1]);
      expect(progressTexts).toContain('Waiting for your input.');
      expect(progressTexts.some((text) => text === 'Done.')).toBe(false);
    });

    it('marks progress done after a plain final question turn', async () => {
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
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
          await onOutput?.({
            status: 'success',
            result: 'Which project should this position use?',
          });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Which project should this position use?',
      );
      const progressTexts = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.map((call) => call[1]);
      expect(progressTexts.some((text) => text === 'Done.')).toBe(true);
      expect(progressTexts).not.toContain('Waiting for your input.');
    });

    it('marks progress done when a final question has examples after the question mark', async () => {
      const channel = makeChannel({
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
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
          await onOutput?.({
            status: 'success',
            result:
              'To get started, I need the role title — what position are you opening? (e.g., Backend Engineer, Product Manager, Data Analyst, etc.)',
          });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const progressTexts = (
        channel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.map((call) => call[1]);
      expect(progressTexts.some((text) => text === 'Done.')).toBe(true);
      expect(progressTexts).not.toContain('Waiting for your input.');
    });

    it('excludes permission wait time from final elapsed progress', async () => {
      vi.useFakeTimers();
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await vi.advanceTimersByTimeAsync(30_000);
          await onOutput?.({ status: 'success', result: 'after approval' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(streamingChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Waiting for your input.',
        expect.objectContaining({ replaceOnly: true }),
      );
      expect(streamingChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Done.',
        expect.objectContaining({ done: true }),
      );
      vi.useRealTimers();
    });

    it('demotes long permission waits to background and resumes on a fresh generation', async () => {
      vi.useFakeTimers();
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await vi.advanceTimersByTimeAsync(121_000);
          await onOutput?.({ status: 'success', result: 'after approval' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(streamingChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'Running in background...',
        expect.objectContaining({ done: true, replaceOnly: true }),
      );
      const calls = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls;
      const beforeGeneration = calls.find(
        (call) => call[1] === 'before approval',
      )?.[2]?.generation;
      const afterGeneration = calls.find(
        (call) => call[1] === 'after approval',
      )?.[2]?.generation;
      expect(afterGeneration).not.toBe(beforeGeneration);
      vi.useRealTimers();
    });

    it('durably sends pre-boundary output before waiting when streaming is disabled', async () => {
      const streamingChannel = makeChannel({
        supportsStreaming: vi.fn().mockReturnValue(false),
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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

      expect(streamingChannel.sendStreamingChunk).not.toHaveBeenCalled();
      expect(streamingChannel.sendMessage).toHaveBeenCalledTimes(2);
      expect(streamingChannel.sendMessage).toHaveBeenNthCalledWith(
        1,
        'group1@g.us',
        'before approval',
      );
      expect(streamingChannel.sendMessage).toHaveBeenNthCalledWith(
        2,
        'group1@g.us',
        'after approval',
      );

      const waitingProgressCallIndex = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.findIndex((call) => call[1] === 'Waiting for your input.');
      const beforeMessageCallOrder = (
        streamingChannel.sendMessage as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[0];
      const waitingProgressCallOrder =
        waitingProgressCallIndex >= 0
          ? (streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>)
              .mock.invocationCallOrder[waitingProgressCallIndex]
          : Number.MAX_SAFE_INTEGER;
      expect(beforeMessageCallOrder).toBeLessThan(waitingProgressCallOrder);
    });

    it('does not send a direct response receipt when progress is unavailable', async () => {
      const channel = makeChannel({
        supportsStreaming: vi.fn().mockReturnValue(false),
        supportsProgress: vi.fn().mockReturnValue(false),
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
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
          await onOutput?.({ status: 'success', result: 'before question' });
          await onOutput?.({
            status: 'success',
            result: null,
            interactionBoundary: 'user_interaction',
          });
          await onOutput?.({ status: 'success', result: 'after question' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendProgressUpdate).not.toHaveBeenCalled();
      expect(channel.sendMessage).toHaveBeenCalledTimes(2);
      expect(channel.sendMessage).toHaveBeenNthCalledWith(
        1,
        'group1@g.us',
        'before question',
      );
      expect(channel.sendMessage).toHaveBeenNthCalledWith(
        2,
        'group1@g.us',
        'after question',
      );
      expect(channel.sendMessage).not.toHaveBeenCalledWith(
        'group1@g.us',
        'Response received. Continuing...',
      );
    });

    it('emits only one response receipt before continuation output chunks', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
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
          await onOutput?.({ status: 'success', result: 'before question' });
          await onOutput?.({
            status: 'success',
            result: null,
            interactionBoundary: 'user_interaction',
          });
          await onOutput?.({ status: 'success', result: 'after-1' });
          await onOutput?.({ status: 'success', result: 'after-2' });
          await onOutput?.({ status: 'success', result: null });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const receiptCalls = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        (call) => call[1] === 'Response received. Continuing...',
      );
      expect(receiptCalls).toHaveLength(1);
      const receiptOrder = (
        streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder[
        (
          streamingChannel.sendProgressUpdate as ReturnType<typeof vi.fn>
        ).mock.calls.findIndex(
          (call) => call[1] === 'Response received. Continuing...',
        )
      ];
      const firstContinuationOrder = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.invocationCallOrder.find(
        (_order, index) =>
          (streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>).mock
            .calls[index]?.[1] === 'after-1',
      );
      expect(receiptOrder).toBeLessThan(
        firstContinuationOrder ?? Number.MAX_SAFE_INTEGER,
      );
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
            '<gantry_memory_context>memory</gantry_memory_context>',
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
          sender: 'gantry',
          sender_name: 'Gantry',
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

    it('bounds provider-visible streamed output and persisted transcript for large chunked output', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;
      (deps.opsRepository as any).storeMessage = vi
        .fn()
        .mockResolvedValue(undefined);

      const tailChunk = `TAIL-${'z'.repeat(100)}END`;
      const splitProviderHandle = 'provider-session:large-live-output';
      const chunks = [
        `HEAD-START${'a'.repeat(900)}`,
        ...Array.from(
          { length: 8 },
          (_, index) => `MIDDLE-${index}-${'b'.repeat(900)}`,
        ),
        `${splitProviderHandle} ${tailChunk}`,
      ];
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          for (const chunk of chunks) {
            await onOutput?.({ status: 'success', result: chunk });
          }
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const streamedChunks = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls
        .map((call) => call[1])
        .filter((text): text is string => Boolean(text));
      expect(streamedChunks.length).toBeGreaterThan(1);
      const deliveredStream = streamedChunks.join('');
      expect(deliveredStream).toContain('HEAD-START');
      expect(deliveredStream).not.toContain(splitProviderHandle);
      expect(deliveredStream).toContain('[REDACTED]');
      expect(deliveredStream.endsWith(tailChunk)).toBe(true);
      const storedTranscript = (deps.opsRepository as any).storeMessage.mock
        .calls[0][0].content as string;
      expect(storedTranscript.length).toBeLessThanOrEqual(
        RUNTIME_RESULT_SUMMARY_MAX_CHARS,
      );
      expect(storedTranscript).toMatch(/^\[output truncated; showing tail\]\n/);
      expect(storedTranscript).not.toContain('HEAD-START');
      expect(storedTranscript).not.toContain(splitProviderHandle);
      expect(storedTranscript).toContain('[REDACTED]');
      expect(storedTranscript.endsWith(tailChunk)).toBe(true);
    });

    it('caps fallback transcript when streamed chunks are not delivered', async () => {
      const streamingChannel = makeChannel({
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendStreamingChunk: vi.fn().mockResolvedValue(false),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;

      const tailChunk = `TAIL-${'z'.repeat(100)}END`;
      const chunks = [
        `HEAD-START${'a'.repeat(900)}`,
        ...Array.from(
          { length: 8 },
          (_, index) => `MIDDLE-${index}-${'b'.repeat(900)}`,
        ),
        tailChunk,
      ];
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          for (const chunk of chunks) {
            await onOutput?.({ status: 'success', result: chunk });
          }
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const streamedChunks = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls
        .map((call) => call[1])
        .filter((text): text is string => Boolean(text));
      expect(streamedChunks.length).toBeGreaterThan(1);
      expect(streamedChunks.join('')).toContain('HEAD-START');
      expect(streamedChunks.join('').endsWith(tailChunk)).toBe(true);
      const fallbackText = (
        streamingChannel.sendMessage as ReturnType<typeof vi.fn>
      ).mock.calls[0][1] as string;
      expect(fallbackText.length).toBeLessThanOrEqual(
        RUNTIME_RESULT_SUMMARY_MAX_CHARS,
      );
      expect(fallbackText).toMatch(/^\[output truncated; showing tail\]\n/);
      expect(fallbackText).not.toContain('HEAD-START');
      expect(fallbackText.endsWith(tailChunk)).toBe(true);
    });

    it('caps the persisted run summary for one long streamed delta while sending one bounded final chunk', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('run-1');
      (deps.opsRepository as any).completeSessionAgentRun = vi.fn();

      const longDelta = `HEAD-START${'x'.repeat(
        RUNTIME_RESULT_SUMMARY_MAX_CHARS + 250,
      )}TAIL-END`;
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: longDelta });
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const deliveredChunk = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[1] as string;
      expect(deliveredChunk).toContain('HEAD-START');
      expect(deliveredChunk.endsWith('TAIL-END')).toBe(true);
      const completion = (deps.opsRepository as any).completeSessionAgentRun
        .mock.calls[0][0];
      const summary = completion.resultSummary as string;
      expect(summary.length).toBeLessThanOrEqual(
        RUNTIME_RESULT_SUMMARY_MAX_CHARS,
      );
      expect(summary).toMatch(/^\[output truncated; showing tail\]\n/);
      expect(summary).not.toContain('HEAD-START');
      expect(summary.endsWith('TAIL-END')).toBe(true);
    });

    it('keeps a bounded tail summary across chunked streamed output', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn().mockResolvedValue(true),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('run-1');
      (deps.opsRepository as any).completeSessionAgentRun = vi.fn();

      const chunks = [
        `HEAD-START${'a'.repeat(2_000)}`,
        `MIDDLE${'b'.repeat(2_300)}`,
        'TAIL-END',
      ];
      mockSpawnAgent.mockImplementation(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          for (const chunk of chunks) {
            await onOutput?.({ status: 'success', result: chunk });
          }
          return { status: 'success', result: null } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const deliveredChunk = (
        streamingChannel.sendStreamingChunk as ReturnType<typeof vi.fn>
      ).mock.calls[0]?.[1] as string;
      expect(deliveredChunk).toContain('HEAD-START');
      const completion = (deps.opsRepository as any).completeSessionAgentRun
        .mock.calls[0][0];
      const summary = completion.resultSummary as string;
      expect(summary.length).toBeLessThanOrEqual(
        RUNTIME_RESULT_SUMMARY_MAX_CHARS,
      );
      expect(summary).toMatch(/^\[output truncated; showing tail\]\n/);
      expect(summary).not.toContain('HEAD-START');
      expect(summary.endsWith('TAIL-END')).toBe(true);
    });

    it('falls back to normal final delivery and marks progress incomplete when final streaming delivery fails', async () => {
      const streamingChannel = makeChannel({
        sendStreamingChunk: vi.fn(async (_jid, _text, options) => {
          if (options?.done) {
            throw new Error('done marker failed');
          }
          return true;
        }),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendProgressUpdate: vi.fn().mockResolvedValue(undefined),
      });
      const { deps } = setupHappyPath();
      deps.channelRuntime = streamingChannel;
      (deps.opsRepository as any).storeMessage = vi
        .fn()
        .mockResolvedValue(undefined);

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

      expect(streamingChannel.sendMessage).not.toHaveBeenCalled();
      expect(streamingChannel.sendProgressUpdate).toHaveBeenCalledWith(
        'group1@g.us',
        'I hit an issue.',
        expect.objectContaining({ done: true }),
      );
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
        [
          'group1@g.us',
          expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        ],
        'thread-a',
        undefined,
      );
      expect(mockSpawnAgent).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          chatJid: 'group1@g.us',
          threadId: 'thread-a',
        }),
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          executionAdapter: expect.objectContaining({
            id: 'anthropic:claude-agent-sdk',
          }),
        }),
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
      const group = makeGroup({ requiresTrigger: false });
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
        {},
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
      const group = makeGroup({ requiresTrigger: false });
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
        [
          expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
          ),
        ],
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
        folder: 'my-group',
        requiresTrigger: false,
        agentConfig: { thinking: { mode: 'adaptive' } },
      });
      const { deps } = setupHappyPath({ group });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        group,
        expect.objectContaining({
          prompt: 'formatted prompt',
          workspaceFolder: 'my-group',
          chatJid: 'group1@g.us',
          assistantName: 'Andy',
          thinking: { mode: 'adaptive' },
        }),
        expect.any(Function), // onProcess
        expect.any(Function), // onOutput
        expect.objectContaining({
          executionAdapter: expect.objectContaining({
            id: 'anthropic:claude-agent-sdk',
          }),
        }), // options
      );
      expect(mockSpawnAgent.mock.calls[0][1]).not.toHaveProperty('sessionId');
    });

    it('keeps unfenced interactive permission and question IPC outside scheduled run identity', async () => {
      const { deps } = setupHappyPath();
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:interactive-1');

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const agentInput = mockSpawnAgent.mock.calls[0][1];
      expect(agentInput).not.toHaveProperty('runId');
      expect(agentInput).not.toHaveProperty('runLeaseToken');
      expect(agentInput).not.toHaveProperty('runLeaseFencingVersion');
      expect(mockSpawnAgent.mock.calls[0][4]).toMatchObject({
        correlationRunId: 'agent-run:interactive-1',
      });
      expect(mockLogger.updateLogContext).toHaveBeenCalledWith(
        expect.objectContaining({ runId: 'agent-run:interactive-1' }),
      );
    });

    it('passes channel conversation kind to getAgentTurnContext', async () => {
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const { deps } = setupHappyPath({ group });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(
        (deps.opsRepository as any).getAgentTurnContext,
      ).toHaveBeenCalledWith({
        appId: 'default',
        agentFolder: 'my-group',
        executionProviderId: 'anthropic:claude-agent-sdk',
        conversationJid: 'group1@g.us',
        providerAccountId: undefined,
        threadId: null,
        conversationKind: 'channel',
        memoryUserId: 'user1@s.whatsapp.net',
        hydrationMode: 'first_visible',
        promoteReadyProviderSession: true,
        query: 'hello',
      });
    });

    it('formats selected conversation context and uses it for bounded recall', async () => {
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        content: '@Andy what did we decide?',
        thread_id: 'thread-1',
        timestamp: '2024-01-01T00:04:00.000Z',
      });
      const recent = makeMessage({
        id: 'recent',
        content: 'channel decision',
        timestamp: '2024-01-01T00:01:00.000Z',
      });
      const root = makeMessage({
        id: 'root',
        content: 'thread root',
        thread_id: 'thread-1',
        timestamp: '2024-01-01T00:02:00.000Z',
      });
      const priorReply = makeMessage({
        id: 'reply',
        content: 'thread reply',
        thread_id: 'thread-1',
        timestamp: '2024-01-01T00:03:00.000Z',
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue([recent]);
      (deps.opsRepository as any).getFirstThreadMessages = vi
        .fn()
        .mockResolvedValue([root]);
      (deps.opsRepository as any).getLatestThreadMessages = vi
        .fn()
        .mockResolvedValue([root, priorReply, current]);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          recentChannelContext: [recent],
          activeThreadContext: [root, priorReply],
          currentMessages: [current],
        }),
        'UTC',
      );
      const query = (deps.opsRepository as any).getAgentTurnContext.mock
        .calls[0][0].query;
      expect(query).toContain('channel decision');
      expect(query).toContain('thread root');
      expect(query).toContain('thread reply');
      expect(query).toContain('what did we decide?');
    });

    it('persists provider hydration and rebuilds incomplete selected conversation context', async () => {
      const group = makeGroup({
        folder: 'my-group',
        providerAccountId: 'telegram_account_2',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        chat_jid: 'tg:-100123',
        content: '@Andy use the topic context',
        thread_id: '42',
        timestamp: '2024-01-01T00:04:00.000Z',
      });
      const hydratedRoot = makeMessage({
        id: 'hydrated-root',
        chat_jid: 'tg:-100123',
        external_message_id: '42',
        content: 'stored hydrated root',
        thread_id: '42',
        timestamp: '2024-01-01T00:01:00.000Z',
      });
      const hydratedReply = makeMessage({
        id: 'hydrated-reply',
        chat_jid: 'tg:-100123',
        content: 'stored hydrated reply',
        thread_id: '42',
        timestamp: '2024-01-01T00:02:00.000Z',
      });
      const channel = makeChannel({
        hydrateConversationContext: vi.fn().mockResolvedValue({
          providerId: 'telegram',
          attempted: true,
          messages: [hydratedRoot, hydratedReply],
        }),
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      deps.channelRuntime = channel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue([]);
      (deps.opsRepository as any).getFirstThreadMessages = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([hydratedRoot]);
      (deps.opsRepository as any).getLatestThreadMessages = vi
        .fn()
        .mockResolvedValueOnce([current])
        .mockResolvedValue([hydratedRoot, hydratedReply, current]);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('tg:-100123::thread:42');

      expect(channel.hydrateConversationContext).toHaveBeenCalledWith({
        conversationJid: 'tg:-100123',
        providerAccountId: 'telegram_account_2',
        threadId: '42',
        latestMessage: current,
        limits: { channelMessages: 30, threadMessages: 50 },
      });
      expect((deps.opsRepository as any).storeMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: hydratedRoot.id,
          providerAccountId: 'telegram_account_2',
        }),
      );
      expect((deps.opsRepository as any).storeMessage).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: hydratedReply.id,
          providerAccountId: 'telegram_account_2',
        }),
      );
      expect(
        (deps.opsRepository as any).getFirstThreadMessages.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        (channel.hydrateConversationContext as ReturnType<typeof vi.fn>).mock
          .invocationCallOrder[0],
      );
      expect(
        (deps.opsRepository as any).storeMessage.mock.invocationCallOrder[1],
      ).toBeLessThan(
        (deps.opsRepository as any).getFirstThreadMessages.mock
          .invocationCallOrder[1],
      );
      expect(
        (deps.opsRepository as any).storeMessage.mock.invocationCallOrder[1],
      ).toBeLessThan(
        mockFormatConversationContextMessages.mock.invocationCallOrder[0],
      );
      expect(
        (deps.opsRepository as any).getFirstThreadMessages,
      ).toHaveBeenCalledTimes(2);
      expect(
        (deps.opsRepository as any).getLatestThreadMessages,
      ).toHaveBeenCalledTimes(2);
      expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          activeThreadContext: [hydratedRoot, hydratedReply],
          currentMessages: [current],
        }),
        'UTC',
      );
      const query = (deps.opsRepository as any).getAgentTurnContext.mock
        .calls[0][0].query;
      expect(query).toContain('stored hydrated root');
      expect(query).toContain('stored hydrated reply');
      expect(query).toContain('use the topic context');
    });

    it('skips hydrated self and bot messages before persistence and rebuilt context', async () => {
      const rawHydratedSelfText = 'RAW HYDRATED SELF OUTBOUND TEXT';
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        chat_jid: 'tg:-100123',
        content: '@Andy continue from stored context',
        thread_id: '42',
        timestamp: '2024-01-01T00:04:00.000Z',
      });
      const hydratedOutboundDuplicate = makeMessage({
        id: 'provider-outbound-42',
        chat_jid: 'tg:-100123',
        sender: 'gantry-bot',
        external_message_id: 'provider-outbound-42',
        content: rawHydratedSelfText,
        thread_id: '42',
        timestamp: '2024-01-01T00:01:00.000Z',
        is_from_me: true,
        is_bot_message: true,
      });
      const hydratedReply = makeMessage({
        id: 'hydrated-reply',
        chat_jid: 'tg:-100123',
        content: 'stored inbound after self skip',
        thread_id: '42',
        timestamp: '2024-01-01T00:02:00.000Z',
      });
      const channel = makeChannel({
        hydrateConversationContext: vi.fn().mockResolvedValue({
          providerId: 'telegram',
          attempted: true,
          messages: [hydratedOutboundDuplicate, hydratedReply],
        }),
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      deps.channelRuntime = channel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).storeMessage = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue([]);
      (deps.opsRepository as any).getFirstThreadMessages = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([]);
      (deps.opsRepository as any).getLatestThreadMessages = vi
        .fn()
        .mockResolvedValueOnce([current])
        .mockResolvedValue([hydratedReply, current]);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('tg:-100123::thread:42');

      expect(result).toBe(true);
      expect((deps.opsRepository as any).storeMessage).toHaveBeenCalledTimes(1);
      expect((deps.opsRepository as any).storeMessage).toHaveBeenCalledWith(
        hydratedReply,
      );
      expect((deps.opsRepository as any).storeMessage).not.toHaveBeenCalledWith(
        hydratedOutboundDuplicate,
      );
      expect(
        (deps.opsRepository as any).getFirstThreadMessages,
      ).toHaveBeenCalledTimes(2);
      expect(
        (deps.opsRepository as any).getLatestThreadMessages,
      ).toHaveBeenCalledTimes(2);
      expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          activeThreadContext: [hydratedReply],
          currentMessages: [current],
        }),
        'UTC',
      );
      expect(mockSpawnAgent).toHaveBeenCalledWith(
        group,
        expect.objectContaining({ prompt: 'formatted prompt' }),
        expect.any(Function),
        expect.any(Function),
        expect.any(Object),
      );
      const query = (deps.opsRepository as any).getAgentTurnContext.mock
        .calls[0][0].query;
      expect(query).toContain('stored inbound after self skip');
      expect(query).not.toContain(rawHydratedSelfText);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'tg:-100123',
          providerId: 'telegram',
          messageCount: 2,
          droppedCount: 1,
        }),
        'Conversation context hydration dropped messages before persistence',
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.any(Object),
          hydration: expect.objectContaining({
            providerId: 'telegram',
            messageCount: 2,
            storeAttemptedMessageCount: 1,
            storedMessageCount: 1,
            storeFailedMessageCount: 0,
            droppedMessageCount: 1,
          }),
        }),
        'Processing messages with conversation context',
      );
      const loggerCalls = [
        ...mockLogger.warn.mock.calls,
        ...mockLogger.info.mock.calls,
        ...mockLogger.debug.mock.calls,
        ...mockLogger.error.mock.calls,
      ];
      expect(JSON.stringify(loggerCalls)).not.toContain(rawHydratedSelfText);
    });

    it('logs only bounded diagnostics when provider context hydration rejects', async () => {
      const providerSecret = 'sk-proj-provider-secret';
      const providerPayload = 'raw provider response body';
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        chat_jid: 'tg:-100123',
        content: '@Andy continue from stored context',
        thread_id: '42',
        timestamp: '2024-01-01T00:04:00.000Z',
        provider: 'telegram',
      });
      const hydrationError = Object.assign(
        new Error(`hydration failed with token ${providerSecret}`),
        {
          name: 'ProviderHydrationError',
          code: 'provider_hydration_failed',
          headers: { authorization: `Bearer ${providerSecret}` },
          response: { body: providerPayload },
          request: { metadata: { token: providerSecret } },
        },
      );
      const channel = makeChannel({
        hydrateConversationContext: vi.fn().mockRejectedValue(hydrationError),
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      deps.channelRuntime = channel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue([]);
      (deps.opsRepository as any).getFirstThreadMessages = vi
        .fn()
        .mockResolvedValue([]);
      (deps.opsRepository as any).getLatestThreadMessages = vi
        .fn()
        .mockResolvedValue([current]);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('tg:-100123::thread:42');

      expect(result).toBe(true);
      expect(channel.hydrateConversationContext).toHaveBeenCalledWith({
        conversationJid: 'tg:-100123',
        threadId: '42',
        latestMessage: current,
        limits: { channelMessages: 30, threadMessages: 50 },
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        {
          hydrationError: {
            errorName: 'ProviderHydrationError',
            errorCode: 'provider_hydration_failed',
          },
          providerId: 'telegram',
          chatJid: 'tg:-100123',
          threadId: '42',
        },
        'Conversation context hydration failed',
      );
      const hydrationWarnContext = mockLogger.warn.mock.calls.find(
        ([, message]) => message === 'Conversation context hydration failed',
      )?.[0] as Record<string, unknown> | undefined;
      expect(hydrationWarnContext).not.toHaveProperty('err');
      const loggerCalls = [
        ...mockLogger.warn.mock.calls,
        ...mockLogger.info.mock.calls,
        ...mockLogger.debug.mock.calls,
        ...mockLogger.error.mock.calls,
      ];
      const serializedLoggerCalls = JSON.stringify(loggerCalls);
      expect(serializedLoggerCalls).toContain('ProviderHydrationError');
      expect(serializedLoggerCalls).toContain('provider_hydration_failed');
      expect(serializedLoggerCalls).not.toContain(providerSecret);
      expect(serializedLoggerCalls).not.toContain(providerPayload);
      expect(serializedLoggerCalls).not.toContain('authorization');
      expect(serializedLoggerCalls).not.toContain('raw provider response');
    });

    it('fails open when provider context hydration does not settle', async () => {
      vi.useFakeTimers();
      try {
        const group = makeGroup({
          folder: 'my-group',
          requiresTrigger: false,
          conversationKind: 'channel',
        });
        const current = makeMessage({
          id: 'current',
          chat_jid: 'tg:-100123',
          content: '@Andy continue without provider hydration',
          thread_id: '42',
          timestamp: '2024-01-01T00:04:00.000Z',
          provider: 'telegram',
        });
        const neverHydrates = new Promise<never>(() => {});
        const channel = makeChannel({
          hydrateConversationContext: vi.fn().mockReturnValue(neverHydrates),
        });
        const { deps } = setupHappyPath({ group, messages: [current] });
        deps.channelRuntime = channel;
        (deps.opsRepository as any).getAgentTurnContext = vi
          .fn()
          .mockResolvedValue(undefined);
        (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
          .fn()
          .mockResolvedValue([]);
        (deps.opsRepository as any).getFirstThreadMessages = vi
          .fn()
          .mockResolvedValue([]);
        (deps.opsRepository as any).getLatestThreadMessages = vi
          .fn()
          .mockResolvedValue([current]);

        const { processGroupMessages } = createGroupProcessor(deps);
        const processing = processGroupMessages('tg:-100123::thread:42');
        let settled = false;
        const observed = processing.then((value) => {
          settled = true;
          return value;
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(channel.hydrateConversationContext).toHaveBeenCalledWith({
          conversationJid: 'tg:-100123',
          threadId: '42',
          latestMessage: current,
          limits: { channelMessages: 30, threadMessages: 50 },
        });
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(2_499);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);

        const result = await observed;
        expect(result).toBe(true);
        expect((deps.opsRepository as any).storeMessage).not.toHaveBeenCalled();
        expect(
          (deps.opsRepository as any).getFirstThreadMessages,
        ).toHaveBeenCalledTimes(1);
        expect(
          (deps.opsRepository as any).getLatestThreadMessages,
        ).toHaveBeenCalledTimes(1);
        expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
          expect.objectContaining({
            activeThreadContext: [],
            currentMessages: [current],
          }),
          'UTC',
        );
        expect(mockSpawnAgent).toHaveBeenCalledWith(
          group,
          expect.objectContaining({ prompt: 'formatted prompt' }),
          expect.any(Function),
          expect.any(Function),
          expect.any(Object),
        );
        expect(mockLogger.warn).toHaveBeenCalledWith(
          {
            providerId: 'telegram',
            chatJid: 'tg:-100123',
            threadId: '42',
            timeoutMs: 2_500,
          },
          'Conversation context hydration timed out',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops non-allowlisted and self/bot hydrated messages before storing or recall', async () => {
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        chat_jid: 'sl:C123',
        sender: 'allowed-user',
        content: '@Andy use the safe context',
        thread_id: '1710000000.000000',
        timestamp: '2024-01-01T00:04:00.000Z',
      });
      const allowedHydrated = makeMessage({
        id: 'hydrated-allowed',
        chat_jid: 'sl:C123',
        sender: 'allowed-user',
        content: 'allowed hydrated history',
        thread_id: '1710000000.000000',
        timestamp: '2024-01-01T00:01:00.000Z',
      });
      const disallowedHydrated = makeMessage({
        id: 'hydrated-disallowed',
        chat_jid: 'sl:C123',
        sender: 'blocked-user',
        content: 'blocked hydrated history',
        thread_id: '1710000000.000000',
        timestamp: '2024-01-01T00:02:00.000Z',
      });
      const gantrySelfHydrated = makeMessage({
        id: 'hydrated-self',
        chat_jid: 'sl:C123',
        sender: 'gantry-bot',
        content: 'gantry self hydrated history',
        thread_id: '1710000000.000000',
        timestamp: '2024-01-01T00:03:00.000Z',
        is_from_me: true,
        is_bot_message: true,
      });
      const botHydrated = makeMessage({
        id: 'hydrated-bot',
        chat_jid: 'sl:C123',
        sender: 'third-party-bot',
        content: 'bot hydrated history',
        thread_id: '1710000000.000000',
        timestamp: '2024-01-01T00:03:30.000Z',
        is_bot_message: true,
      });
      const channel = makeChannel({
        hydrateConversationContext: vi.fn().mockResolvedValue({
          providerId: 'slack',
          attempted: true,
          messages: [
            allowedHydrated,
            disallowedHydrated,
            gantrySelfHydrated,
            botHydrated,
          ],
        }),
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      deps.channelRuntime = channel;
      mockShouldDropMessage.mockReturnValue(true);
      mockIsSenderAllowed.mockImplementation(
        (_chatJid, sender) => sender === 'allowed-user',
      );
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue([]);
      (deps.opsRepository as any).getFirstThreadMessages = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([allowedHydrated]);
      (deps.opsRepository as any).getLatestThreadMessages = vi
        .fn()
        .mockResolvedValueOnce([current])
        .mockResolvedValue([allowedHydrated, current]);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('sl:C123::thread:1710000000.000000');

      expect(mockShouldDropMessage).toHaveBeenCalledWith(
        'sl:C123',
        {},
        'my-group',
      );
      expect(mockShouldDropMessage).toHaveBeenCalledTimes(2);
      expect(mockIsSenderAllowed).toHaveBeenCalledWith(
        'sl:C123',
        'blocked-user',
        {},
        'my-group',
      );
      expect(mockIsSenderAllowed).not.toHaveBeenCalledWith(
        'sl:C123',
        'gantry-bot',
        {},
        'my-group',
      );
      expect(mockIsSenderAllowed).not.toHaveBeenCalledWith(
        'sl:C123',
        'third-party-bot',
        {},
        'my-group',
      );
      expect((deps.opsRepository as any).storeMessage).toHaveBeenCalledTimes(1);
      expect((deps.opsRepository as any).storeMessage).toHaveBeenCalledWith(
        allowedHydrated,
      );
      expect((deps.opsRepository as any).storeMessage).not.toHaveBeenCalledWith(
        gantrySelfHydrated,
      );
      expect((deps.opsRepository as any).storeMessage).not.toHaveBeenCalledWith(
        disallowedHydrated,
      );
      expect((deps.opsRepository as any).storeMessage).not.toHaveBeenCalledWith(
        botHydrated,
      );
      expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          activeThreadContext: [allowedHydrated],
          currentMessages: [current],
        }),
        'UTC',
      );
      const formattedContext =
        mockFormatConversationContextMessages.mock.calls[0][0];
      expect(formattedContext.activeThreadContext).not.toContain(
        disallowedHydrated,
      );
      expect(formattedContext.activeThreadContext).not.toContain(
        gantrySelfHydrated,
      );
      expect(formattedContext.activeThreadContext).not.toContain(botHydrated);
      const query = (deps.opsRepository as any).getAgentTurnContext.mock
        .calls[0][0].query;
      expect(query).toContain('allowed hydrated history');
      expect(query).not.toContain('gantry self hydrated history');
      expect(query).not.toContain('bot hydrated history');
      expect(query).not.toContain('blocked hydrated history');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        {
          chatJid: 'sl:C123',
          providerId: 'slack',
          messageCount: 4,
          droppedCount: 3,
        },
        'Conversation context hydration dropped messages before persistence',
      );
    });

    it('does not hydrate when stored channel context already has the full local window', async () => {
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        content: '@Andy use stored channel context',
        timestamp: '2024-01-01T00:31:00.000Z',
      });
      const storedChannelMessages = Array.from({ length: 30 }, (_, index) =>
        makeMessage({
          id: `stored-channel-${index + 1}`,
          content: `stored channel ${index + 1}`,
          timestamp: `2024-01-01T00:${String(index + 1).padStart(
            2,
            '0',
          )}:00.000Z`,
        }),
      );
      const channel = makeChannel({
        hydrateConversationContext: vi.fn().mockResolvedValue({
          providerId: 'slack',
          attempted: true,
          messages: [],
        }),
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      deps.channelRuntime = channel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue(storedChannelMessages);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.hydrateConversationContext).not.toHaveBeenCalled();
      expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          recentChannelContext: storedChannelMessages,
          currentMessages: [current],
        }),
        'UTC',
      );
    });

    it('does not hydrate when stored active thread context already has the full local window and root', async () => {
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        chat_jid: 'sl:C123',
        content: '@Andy use stored thread context',
        external_message_id: '1710000050.000000',
        thread_id: '1710000000.000000',
        timestamp: '2024-01-01T00:51:00.000Z',
      });
      const storedThreadMessages = Array.from({ length: 50 }, (_, index) =>
        makeMessage({
          id: `stored-thread-${index + 1}`,
          chat_jid: 'sl:C123',
          content: `stored thread ${index + 1}`,
          external_message_id:
            index === 0
              ? '1710000000.000000'
              : `17100000${String(index).padStart(2, '0')}.000000`,
          thread_id: '1710000000.000000',
          timestamp: `2024-01-01T00:${String(index + 1).padStart(
            2,
            '0',
          )}:00.000Z`,
        }),
      );
      const channel = makeChannel({
        hydrateConversationContext: vi.fn().mockResolvedValue({
          providerId: 'slack',
          attempted: true,
          messages: [],
        }),
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      deps.channelRuntime = channel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue([]);
      (deps.opsRepository as any).getFirstThreadMessages = vi
        .fn()
        .mockResolvedValue(storedThreadMessages.slice(0, 11));
      (deps.opsRepository as any).getLatestThreadMessages = vi
        .fn()
        .mockResolvedValue(storedThreadMessages);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('sl:C123::thread:1710000000.000000');

      expect(channel.hydrateConversationContext).not.toHaveBeenCalled();
      expect(mockFormatConversationContextMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          activeThreadContext: storedThreadMessages,
          currentMessages: [current],
        }),
        'UTC',
      );
    });

    it('hydrates when stored active thread context has a full local window but no explicit root', async () => {
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const current = makeMessage({
        id: 'current',
        chat_jid: 'dc:thread-1',
        content: '@Andy use stored thread context',
        external_message_id: 'discord-current',
        thread_id: 'discord-thread-1',
        timestamp: '2024-01-01T00:51:00.000Z',
      });
      const storedThreadReplies = Array.from({ length: 50 }, (_, index) =>
        makeMessage({
          id: `stored-reply-${index + 1}`,
          chat_jid: 'dc:thread-1',
          content: `stored reply ${index + 1}`,
          external_message_id: `discord-reply-${index + 1}`,
          thread_id: 'discord-thread-1',
          timestamp: `2024-01-01T00:${String(index + 1).padStart(
            2,
            '0',
          )}:00.000Z`,
        }),
      );
      const channel = makeChannel({
        hydrateConversationContext: vi.fn().mockResolvedValue({
          providerId: 'discord',
          attempted: true,
          messages: [],
        }),
      });
      const { deps } = setupHappyPath({ group, messages: [current] });
      deps.channelRuntime = channel;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);
      (deps.opsRepository as any).getRecentTopLevelMessagesBefore = vi
        .fn()
        .mockResolvedValue([]);
      (deps.opsRepository as any).getFirstThreadMessages = vi
        .fn()
        .mockResolvedValue(storedThreadReplies.slice(0, 11));
      (deps.opsRepository as any).getLatestThreadMessages = vi
        .fn()
        .mockResolvedValue(storedThreadReplies);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('dc:thread-1::thread:discord-thread-1');

      expect(channel.hydrateConversationContext).toHaveBeenCalledWith({
        conversationJid: 'dc:thread-1',
        threadId: 'discord-thread-1',
        latestMessage: current,
        limits: { channelMessages: 30, threadMessages: 50 },
      });
    });

    it('uses bounded user-visible message text as memory recall query', async () => {
      const group = makeGroup({
        folder: 'my-group',
        requiresTrigger: false,
        conversationKind: 'channel',
      });
      const longContent = `<gantry_memory_context>${Array.from(
        { length: 140 },
        (_, index) => `term${index}`,
      ).join(' ')}</gantry_memory_context>`;
      const { deps } = setupHappyPath({
        group,
        messages: [makeMessage({ content: longContent })],
      });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const query = (deps.opsRepository as any).getAgentTurnContext.mock
        .calls[0][0].query;
      expect(query).not.toContain('gantry_memory_context');
      expect(query.split(/\s+/)).toHaveLength(80);
      expect(query.length).toBeLessThanOrEqual(1200);
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
        registeredJids?: string[];
        depsOverrides?: Partial<GroupProcessingDeps>;
      } = {},
    ) {
      const group = opts.group ?? makeGroup({ folder: 'grp-folder' });
      const channel = makeChannel();
      const messages = opts.messages ?? [makeMessage()];

      const deps = makeDeps({
        channelRuntime: channel,
        getGroup: vi.fn().mockReturnValue(group),
        getRegisteredJids: vi
          .fn()
          .mockReturnValue(new Set(opts.registeredJids ?? [])),
        ...opts.depsOverrides,
      });
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:test',
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

    it('wires durable session compaction admission into session command deps', async () => {
      const task = {
        id: 'task-session-compact',
        appId: 'app:test',
        agentId: 'agent:test',
        kind: 'session_compaction',
        status: 'queued',
        admissionClass: 'task',
        authoritySnapshotJson: {},
        privateCorrelationJson: {},
        leaseToken: 'lease-session-compact',
        fencingVersion: 1,
        createdAt: '2026-04-27T00:00:00.000Z',
        updatedAt: '2026-04-27T00:00:00.000Z',
      };
      const repository = {
        createTaskWithScopedAdmission: vi.fn().mockResolvedValue({
          task,
          admitted: true,
          staleTasks: [],
        }),
      };
      const { capturedDeps } = await captureSessionDeps({
        depsOverrides: {
          getAsyncTaskRepository: vi.fn().mockReturnValue(repository),
        },
      });

      const result = await (
        capturedDeps.admitSessionCompactionTask as () => Promise<unknown>
      )();

      expect(result).toMatchObject({ admitted: true, task });
      expect(repository.createTaskWithScopedAdmission).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({
            appId: 'default',
            agentId: 'agent:test',
            conversationId: 'group1@g.us',
            kind: 'session_compaction',
            status: 'queued',
          }),
          activeStatuses: ['queued', 'running'],
          staleRunningStatus: 'timed_out',
        }),
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
      const group = makeGroup({ agentConfig: { model: 'opus' } });
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
      ) => Promise<void>;

      await setGroupModelOverride('sonnet');

      expect(deps.setGroupModelOverride).toHaveBeenCalledWith(
        'group1@g.us',
        'sonnet',
      );
    });

    it('model, thinking, and permission overrides use the selected agent route key', async () => {
      const routeKey = 'group1@g.us::agent:agent%3Atriage';
      const { capturedDeps, deps } = await captureSessionDeps({
        queueJid: routeKey,
      });
      const setGroupModelOverride = capturedDeps.setGroupModelOverride as (
        v: string | undefined,
      ) => Promise<void>;
      const setGroupThinkingOverride =
        capturedDeps.setGroupThinkingOverride as (v: unknown) => Promise<void>;
      const setGroupPermissionModeOverride =
        capturedDeps.setGroupPermissionModeOverride as (
          v: 'ask' | 'auto' | undefined,
        ) => Promise<void>;

      await setGroupModelOverride('sonnet');
      await setGroupThinkingOverride({ mode: 'disabled' });
      await setGroupPermissionModeOverride('auto');

      expect(deps.setGroupModelOverride).toHaveBeenCalledWith(
        routeKey,
        'sonnet',
      );
      expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(routeKey, {
        mode: 'disabled',
      });
      expect(deps.setGroupPermissionModeOverride).toHaveBeenCalledWith(
        routeKey,
        'auto',
      );
    });

    it('threaded override commands stay scoped to the selected route', async () => {
      const routeKey = 'group1@g.us::thread:thread-1::agent:agent%3Atriage';
      const { capturedDeps, deps } = await captureSessionDeps({
        queueJid: routeKey,
        registeredJids: [routeKey],
      });
      const setGroupModelOverride = capturedDeps.setGroupModelOverride as (
        v: string | undefined,
      ) => Promise<void>;
      const setGroupThinkingOverride =
        capturedDeps.setGroupThinkingOverride as (v: unknown) => Promise<void>;

      await setGroupModelOverride('sonnet');
      await setGroupThinkingOverride({ mode: 'disabled' });

      expect(deps.setGroupModelOverride).toHaveBeenCalledWith(
        routeKey,
        'sonnet',
      );
      expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(routeKey, {
        mode: 'disabled',
      });
    });

    it('threaded overrides update the whole-conversation agent route when matched by fallback', async () => {
      const wholeRouteKey = 'sl:C123::agent:agent%3Atriage';
      const threadedQueueKey = 'sl:C123::thread:1700.1::agent:agent%3Atriage';
      const { capturedDeps, deps } = await captureSessionDeps({
        queueJid: threadedQueueKey,
        messages: [
          makeMessage({
            chat_jid: 'sl:C123',
            content: '/model sonnet',
            thread_id: '1700.1',
          }),
        ],
        registeredJids: [wholeRouteKey],
      });
      const setGroupModelOverride = capturedDeps.setGroupModelOverride as (
        v: string | undefined,
      ) => Promise<void>;
      const setGroupThinkingOverride =
        capturedDeps.setGroupThinkingOverride as (v: unknown) => Promise<void>;
      const setGroupPermissionModeOverride =
        capturedDeps.setGroupPermissionModeOverride as (
          v: 'ask' | 'auto' | undefined,
        ) => Promise<void>;

      await setGroupModelOverride('sonnet');
      await setGroupThinkingOverride({ mode: 'disabled' });
      await setGroupPermissionModeOverride('ask');

      expect(deps.setGroupModelOverride).toHaveBeenCalledWith(
        wholeRouteKey,
        'sonnet',
      );
      expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(
        wholeRouteKey,
        { mode: 'disabled' },
      );
      expect(deps.setGroupPermissionModeOverride).toHaveBeenCalledWith(
        wholeRouteKey,
        'ask',
      );
    });

    it('thread-only /model and /thinking overrides update the resolved agent route', async () => {
      const wholeRouteKey = 'sl:C123::agent:agent%3Atriage';
      const threadedQueueKey = 'sl:C123::thread:1700.1';
      const { capturedDeps, deps } = await captureSessionDeps({
        queueJid: threadedQueueKey,
        group: makeGroup({ folder: 'triage' }),
        messages: [
          makeMessage({
            chat_jid: 'sl:C123',
            content: '/model sonnet',
            thread_id: '1700.1',
          }),
        ],
        registeredJids: [wholeRouteKey],
      });
      const setGroupModelOverride = capturedDeps.setGroupModelOverride as (
        v: string | undefined,
      ) => Promise<void>;
      const setGroupThinkingOverride =
        capturedDeps.setGroupThinkingOverride as (v: unknown) => Promise<void>;

      await setGroupModelOverride('sonnet');
      await setGroupThinkingOverride({ mode: 'disabled' });

      expect(deps.setGroupModelOverride).toHaveBeenCalledWith(
        wholeRouteKey,
        'sonnet',
      );
      expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(
        wholeRouteKey,
        { mode: 'disabled' },
      );
    });

    it('getGroupThinkingOverride returns the group agentConfig.thinking', async () => {
      const group = makeGroup({
        agentConfig: { thinking: { mode: 'enabled' } },
      });
      const { capturedDeps } = await captureSessionDeps({ group });
      const getGroupThinkingOverride =
        capturedDeps.getGroupThinkingOverride as () => unknown;

      expect(getGroupThinkingOverride()).toEqual({ mode: 'enabled' });
    });

    it('provides conversation and resolved default permission modes', async () => {
      mockGetRuntimeSettingsForConfig.mockReturnValue({
        memory: { enabled: true },
        agents: { 'test-group': { permissionMode: 'auto' } },
      });
      const group = makeGroup({ agentConfig: { permissionMode: 'ask' } });
      const { capturedDeps } = await captureSessionDeps({ group });

      expect(
        (capturedDeps.getGroupPermissionModeOverride as () => unknown)(),
      ).toBe('ask');
      expect((capturedDeps.getDefaultPermissionMode as () => unknown)()).toBe(
        'auto',
      );
    });

    it('setGroupThinkingOverride delegates to deps', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const setGroupThinkingOverride =
        capturedDeps.setGroupThinkingOverride as (v: unknown) => Promise<void>;

      await setGroupThinkingOverride({ mode: 'disabled' });

      expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(
        'group1@g.us',
        { mode: 'disabled' },
      );
    });

    it('saveProcedure writes to the whole channel even when a thread is active', async () => {
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
          subjectType: 'channel',
          channelId: 'conversation:group1@g.us',
          key: 'procedure:Deploy flow',
          value: '1. Build\n2. Ship',
        }),
      );
      expect(mockSaveProcedure.mock.calls[0]?.[0]).not.toHaveProperty(
        'threadId',
      );
    });

    it('saveProcedure resolves DM/private commands to user memory without thread scope', async () => {
      const { capturedDeps } = await captureSessionDeps({
        group: makeGroup({ folder: 'dm-agent', conversationKind: 'dm' }),
        messages: [
          makeMessage({
            id: 'dm-save-procedure',
            sender: 'user-dm',
            thread_id: 'ignored-dm-thread',
          }),
        ],
        queueJid: 'dm-conversation::thread:ignored-dm-thread',
      });
      const saveProcedure = capturedDeps.saveProcedure as (input: {
        title: string;
        body: string;
      }) => Promise<unknown>;

      await saveProcedure({ title: 'Travel flow', body: 'Book direct.' });

      expect(mockSaveProcedure).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: 'user',
          userId: 'user-dm',
          key: 'procedure:Travel flow',
          value: 'Book direct.',
        }),
      );
      expect(mockSaveProcedure.mock.calls[0]?.[0]).not.toHaveProperty(
        'threadId',
      );
      expect(mockSaveProcedure.mock.calls[0]?.[0]).not.toHaveProperty(
        'channelId',
      );
    });

    it('runMemoryDreaming runs on the whole channel even when a thread is active', async () => {
      const { capturedDeps, group } = await captureSessionDeps({
        group: makeGroup({ folder: 'threaded-group' }),
        messages: [
          makeMessage({
            id: 'thread-dream',
            content: '/dream',
            thread_id: 'thread-dreaming',
          }),
        ],
        queueJid: 'group1@g.us::thread:thread-dreaming',
      });
      const runMemoryDreaming =
        capturedDeps.runMemoryDreaming as () => Promise<unknown>;

      await runMemoryDreaming();

      expect(mockRunDreamingSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'default',
          agentId: `agent:${group.folder}`,
          subjectType: 'channel',
          subjectId: 'conversation:group1@g.us',
          channelId: 'conversation:group1@g.us',
          phase: 'all',
        }),
      );
      expect(mockRunDreamingSweep.mock.calls[0]?.[0]).not.toHaveProperty(
        'threadId',
      );
    });

    it('runMemoryDreaming resolves DM/private commands to user subject without thread scope', async () => {
      const { capturedDeps } = await captureSessionDeps({
        group: makeGroup({ folder: 'dm-agent', conversationKind: 'dm' }),
        messages: [
          makeMessage({
            id: 'dm-dream',
            content: '/dream',
            sender: 'user-dm',
            thread_id: 'ignored-dm-thread',
          }),
        ],
        queueJid: 'dm-conversation::thread:ignored-dm-thread',
      });
      const runMemoryDreaming =
        capturedDeps.runMemoryDreaming as () => Promise<unknown>;

      await runMemoryDreaming();

      expect(mockRunDreamingSweep).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'default',
          agentId: 'agent:dm-agent',
          subjectType: 'user',
          subjectId: 'user-dm',
          userId: 'user-dm',
          phase: 'all',
        }),
      );
      expect(mockRunDreamingSweep.mock.calls[0]?.[0]).not.toHaveProperty(
        'threadId',
      );
      expect(mockRunDreamingSweep.mock.calls[0]?.[0]).not.toHaveProperty(
        'channelId',
      );
    });

    it('getMemoryStatus reads only the resolved channel subject', async () => {
      const { capturedDeps } = await captureSessionDeps({
        group: makeGroup({ folder: 'status-agent' }),
      });
      const getMemoryStatus =
        capturedDeps.getMemoryStatus as () => Promise<unknown>;

      await getMemoryStatus();

      expect(mockGetMemoryStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'default',
          agentId: 'agent:status-agent',
          channelId: 'conversation:group1@g.us',
          subjectTypes: ['channel'],
          includeCommon: false,
        }),
      );
      expect(mockGetMemoryStatus.mock.calls[0]?.[0]).not.toHaveProperty(
        'groupId',
      );
    });

    it('getMemoryStatus reads only the resolved DM user subject', async () => {
      const { capturedDeps } = await captureSessionDeps({
        group: makeGroup({ folder: 'status-dm', conversationKind: 'dm' }),
        messages: [makeMessage({ sender: 'user-dm' })],
      });
      const getMemoryStatus =
        capturedDeps.getMemoryStatus as () => Promise<unknown>;

      await getMemoryStatus();

      expect(mockGetMemoryStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'default',
          agentId: 'agent:status-dm',
          userId: 'user-dm',
          subjectTypes: ['user'],
          includeCommon: false,
        }),
      );
      expect(mockGetMemoryStatus.mock.calls[0]?.[0]).not.toHaveProperty(
        'threadId',
      );
      expect(mockGetMemoryStatus.mock.calls[0]?.[0]).not.toHaveProperty(
        'channelId',
      );
    });

    it('archiveCurrentSession does not archive provider transcripts', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const archiveCurrentSession = capturedDeps.archiveCurrentSession as (
        cause?: 'new-session' | 'manual-compact',
      ) => Promise<{ memory: 'ok' | 'degraded' | 'skipped' }>;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:test',
        });

      await expect(archiveCurrentSession('new-session')).resolves.toEqual({
        memory: 'ok',
      });

      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({ hydrateMemory: false }),
      );
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
      ) => Promise<{ memory: 'ok' | 'degraded' | 'skipped' }>;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:test',
        });

      await expect(archiveCurrentSession('manual-compact')).resolves.toEqual({
        memory: 'ok',
      });

      expect(deps.collectSessionMemory).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:test',
        trigger: 'precompact',
        defaultScope: 'group',
      });
    });

    it('archiveCurrentSession returns degraded when precompact memory collection fails', async () => {
      const { capturedDeps } = await captureSessionDeps({
        depsOverrides: {
          collectSessionMemory: vi
            .fn()
            .mockRejectedValue(new Error('memory failed')),
        },
      });
      const archiveCurrentSession = capturedDeps.archiveCurrentSession as (
        cause?: 'new-session' | 'manual-compact',
      ) => Promise<{ memory: 'ok' | 'degraded' | 'skipped' }>;

      await expect(archiveCurrentSession('manual-compact')).resolves.toEqual({
        memory: 'degraded',
      });
    });

    it('archiveCurrentSession does nothing when no session', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const archiveCurrentSession =
        capturedDeps.archiveCurrentSession as () => Promise<{
          memory: 'ok' | 'degraded' | 'skipped';
        }>;
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue(undefined);

      await expect(archiveCurrentSession()).resolves.toEqual({
        memory: 'skipped',
      });

      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({ hydrateMemory: false }),
      );
      expect(deps.collectSessionMemory).not.toHaveBeenCalled();
    });

    it('clearCurrentSession resets scoped provider session state', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const clearCurrentSession =
        capturedDeps.clearCurrentSession as () => Promise<void> | void;

      await clearCurrentSession();

      expect(deps.clearSession).toHaveBeenCalledWith(
        'grp-folder',
        undefined,
        expect.objectContaining({
          appId: 'default',
          conversationJid: 'group1@g.us',
        }),
      );
    });

    describe('canSenderInteract', () => {
      it('returns true when requiresTrigger=false', async () => {
        const group = makeGroup({ requiresTrigger: false });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;

        const msg = makeMessage({ content: 'no trigger' });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for another requiresTrigger=false conversation', async () => {
        const group = makeGroup({ requiresTrigger: false });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (
          msg: NewMessage,
        ) => boolean;

        const msg = makeMessage({ content: 'no trigger' });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for conversation-scoped group when trigger present and is_from_me', async () => {
        const group = makeGroup({
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

      it('returns true for conversation-scoped group when trigger present and sender is allowlisted', async () => {
        const group = makeGroup({
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

      it('returns false for conversation-scoped group when trigger present but sender not allowed', async () => {
        const group = makeGroup({
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

      it('returns false for conversation-scoped group when no trigger in message', async () => {
        const group = makeGroup({
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
      const group = makeGroup({ folder: 'grp-folder' });
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
      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({ query: undefined }),
      );
      expect(mockSpawnAgent).toHaveBeenCalledWith(
        group,
        expect.objectContaining({ prompt: 'test prompt' }),
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({
          executionAdapter: expect.objectContaining({
            id: 'anthropic:claude-agent-sdk',
          }),
        }),
      );
    });

    it('runAgent collects memory when SDK auto-compacts', async () => {
      const group = makeGroup({ folder: 'grp-folder' });
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

      expect(deps.collectSessionMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: 'agent-session:test',
          trigger: 'precompact',
          defaultScope: 'group',
          signal: expect.any(AbortSignal),
          timeoutMs: 30_000,
          statementTimeoutMs: 30_000,
        }),
      );
    });
  });

  // =========================================================================
  // Bug-hunting: adversarial edge cases
  // =========================================================================

  describe('stale session set from errored agent run', () => {
    it('should not set session ID when agent returns error status', async () => {
      const group = makeGroup({ requiresTrigger: false });
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

  describe('SDK session ids from streamed + final output', () => {
    it('persists a streamed SDK session ID only once when final output repeats it', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
        expect.objectContaining({
          executionProviderId: 'anthropic:claude-agent-sdk',
          conversationJid: 'group1@g.us',
          conversationKind: undefined,
          memoryUserId: 'user1@s.whatsapp.net',
          expectedAgentSessionId: 'agent-session:1',
          expectedAgentSessionResetAt: null,
        }),
      );
    });

    it('does not retry stale provider-session persistence from SDK output', async () => {
      const group = makeGroup({ requiresTrigger: false });
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
          agentSessionResetAt: '2026-05-11T00:00:00.000Z',
        });
      (deps.opsRepository.setSession as any).mockResolvedValueOnce(false);

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
        expect.objectContaining({
          executionProviderId: 'anthropic:claude-agent-sdk',
          conversationJid: 'group1@g.us',
          conversationKind: undefined,
          memoryUserId: 'user1@s.whatsapp.net',
          expectedAgentSessionId: 'agent-session:1',
          expectedAgentSessionResetAt: '2026-05-11T00:00:00.000Z',
        }),
      );
    });
  });

  // =======================================================================
  // Model-family runtime failover (Phase 3)
  // =======================================================================

  describe('model-family runtime failover', () => {
    // gpt-oss family: members groq-oss (provider groq) and cerebras (provider
    // cerebras). With both configured, candidates = [groq-oss, cerebras].
    function setupFamilyGroup() {
      const group = makeGroup({
        requiresTrigger: false,
        agentConfig: { name: 'Andy', model: 'gpt-oss' },
      });
      const { deps } = setupHappyPath({ group });
      deps.executionAdapters = createAgentExecutionAdapterRegistry([
        deps.executionAdapter!,
        {
          id: 'deepagents:langchain',
          isMissingProviderSessionError: vi.fn(() => false),
          prepare: vi.fn(),
        },
      ]);
      deps.getConfiguredModelProviders = vi.fn(
        async () => new Set(['groq', 'cerebras']),
      );
      deps.getModelFamilyOrder = vi.fn(() => undefined);
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'app:test',
          agentId: 'agent:test',
          agentSessionId: 'agent-session:1',
        });
      (deps.opsRepository as any).createSessionAgentRun = vi
        .fn()
        .mockResolvedValue('agent-run:family-1');
      return { deps, group };
    }

    it('fails over to the next configured provider on a 401 before any output streamed', async () => {
      const { deps } = setupFamilyGroup();
      // First candidate (groq-oss) returns a 401 frame with NO streamed output;
      // the second candidate (cerebras) succeeds.
      mockSpawnAgent.mockImplementationOnce(async () => ({
        status: 'error',
        result: null,
        error: 'API Error: 401 authentication_error invalid api key',
      }));
      mockSpawnAgent.mockImplementationOnce(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          const output: AgentOutput = {
            status: 'success',
            result: 'second provider reply',
          };
          await onOutput?.(output);
          return output;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);

      expect(mockSpawnAgent).toHaveBeenCalledTimes(2);
      // First attempt used the first candidate model (groq-oss).
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        model: 'groq-oss',
      });
      // Second attempt used the NEXT candidate model (cerebras) and NO resume id.
      expect(mockSpawnAgent.mock.calls[1][1]).toMatchObject({
        model: 'cerebras',
      });
      expect(mockSpawnAgent.mock.calls[1][1]).not.toHaveProperty('sessionId');
    });

    it('uses the first concrete family candidate provider for turn context and run creation', async () => {
      const { deps, group } = setupFamilyGroup();

      const { processGroupMessages } = createGroupProcessor(deps);
      await expect(processGroupMessages('group1@g.us')).resolves.toBe(true);

      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({
          agentFolder: group.folder,
          executionProviderId: 'deepagents:langchain',
          conversationJid: 'group1@g.us',
        }),
      );
      expect(deps.opsRepository.createSessionAgentRun).toHaveBeenCalledWith({
        agentSessionId: 'agent-session:1',
        executionProviderId: 'deepagents:langchain',
        providerSessionId: undefined,
        cause: 'message',
      });
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        model: 'groq-oss',
      });
    });

    it('resolves family candidates from the app-session scope instead of default', async () => {
      const { deps, group } = setupFamilyGroup();
      const conversationJid = 'app:tenant:support';
      mockGetMessagesSince.mockReturnValue([
        makeMessage({ chat_jid: conversationJid }),
      ]);
      deps.getConfiguredModelProviders = vi.fn(async (appId: string) =>
        appId === 'tenant' ? new Set(['cerebras']) : new Set(['groq']),
      );
      (deps.opsRepository as any).getAgentTurnContext = vi
        .fn()
        .mockResolvedValue({
          appId: 'tenant',
          agentId: 'agent:tenant',
          agentSessionId: 'agent-session:tenant',
        });

      const { processGroupMessages } = createGroupProcessor(deps);
      await expect(processGroupMessages(conversationJid)).resolves.toBe(true);

      expect(deps.getConfiguredModelProviders).toHaveBeenCalledWith('tenant');
      expect(deps.opsRepository.getAgentTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 'tenant',
          agentFolder: group.folder,
          conversationJid,
        }),
      );
      expect(mockSpawnAgent.mock.calls[0][1]).toMatchObject({
        appId: 'tenant',
        model: 'cerebras',
      });
    });

    it('does NOT fail over once visible output has streamed (safety boundary)', async () => {
      const { deps } = setupFamilyGroup();
      // First candidate streams a delta, THEN errors with a 401: no failover.
      mockSpawnAgent.mockImplementationOnce(
        async (
          _group: ConversationRoute,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          await onOutput?.({ status: 'success', result: 'partial reply' });
          return {
            status: 'error',
            result: null,
            error: 'API Error: 401 invalid api key',
          } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Only ONE spawn: a provider failing mid-stream must not re-run.
      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    });

    it('does NOT fail over on a non-eligible error (stopped by request)', async () => {
      const { deps } = setupFamilyGroup();
      mockSpawnAgent.mockImplementationOnce(async () => ({
        status: 'error',
        result: null,
        error: 'Agent runner stopped by request',
      }));

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
    });

    it('does not fail over when no model override is set (single candidate)', async () => {
      // No agentConfig.model -> the configured interactive default is used, but
      // non-family defaults still produce a single candidate.
      const group = makeGroup({ requiresTrigger: false });
      const { deps } = setupHappyPath({ group });
      deps.getConfiguredModelProviders = vi.fn(
        async () => new Set(['groq', 'cerebras']),
      );
      mockSpawnAgent.mockImplementationOnce(async () => ({
        status: 'error',
        result: null,
        error: 'API Error: 503 service unavailable',
      }));

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent).toHaveBeenCalledTimes(1);
      expect(mockSpawnAgent.mock.calls[0][1]).toHaveProperty('model', 'opus');
    });
  });
});
