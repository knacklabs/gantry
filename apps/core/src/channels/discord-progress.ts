import type { ProgressUpdateOptions } from '../domain/types.js';
import {
  discordJobNotificationEmbed,
  postDiscordMessageParts,
  splitDiscordText,
} from './discord-delivery.js';
import { DiscordRestError } from './discord-http-helpers.js';
import {
  dispatchDiscordProgressUpdate,
  type DiscordProgressEdit,
  type DiscordProgressPost,
} from './discord-progress-dispatch.js';
import {
  DiscordProgressMutationQueue,
  DISCORD_PROGRESS_PROVIDER_SETTLEMENT_WINDOW_MS,
} from './discord-progress-mutation-queue.js';
import { createTrackedDiscordProgressPost } from './discord-progress-post.js';
import {
  discordProgressStateKey,
  type CreateAttempt,
  type CreateAttemptOutcome,
  type CreateSettlement,
  type CreateTombstone,
  type ProgressKeyState,
} from './discord-progress-state.js';
import {
  discordProgressPayloadFingerprint,
  type RetainedTerminalRender,
} from './discord-progress-terminal-render.js';

export type { DiscordProgressEdit, DiscordProgressPost };

export function createDiscordProgressCallbacks(input: {
  channelId: string;
  options: ProgressUpdateOptions;
  post: (
    channelId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ id?: string }>;
  edit: (
    messageId: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<void>;
}): { post: DiscordProgressPost; edit: DiscordProgressEdit } {
  const embed =
    input.options.done && input.options.jobNotificationView
      ? discordJobNotificationEmbed(input.options.jobNotificationView)
      : undefined;
  const postText = (
    text: string,
    components: unknown[] | undefined,
    signal: AbortSignal | undefined,
  ) =>
    postDiscordMessageParts({
      channelId: input.channelId,
      parts: splitDiscordText(text),
      components,
      post: (channelId, body) => input.post(channelId, body, signal),
    });
  return {
    post: async (text, components, signal) => {
      if (!embed) return postText(text, components, signal);
      try {
        return await postDiscordMessageParts({
          channelId: input.channelId,
          parts: [''],
          components,
          embeds: [embed],
          post: (channelId, body) => input.post(channelId, body, signal),
        });
      } catch (err) {
        if (!isDiscordEmbedRejection(err)) throw err;
        return postText(truncateDiscordMessageText(text), components, signal);
      }
    },
    edit: async (messageId, body, signal) => {
      if (!embed) return input.edit(messageId, body, signal);
      try {
        await input.edit(
          messageId,
          { ...body, content: '', embeds: [embed] },
          signal,
        );
      } catch (err) {
        if (!isDiscordEmbedRejection(err)) throw err;
        await input.edit(messageId, { ...body, embeds: [] }, signal);
      }
    },
  };
}

function isDiscordEmbedRejection(err: unknown): boolean {
  if (!(err instanceof DiscordRestError) || err.status !== 400) return false;
  const errors = err.errors ?? {};
  return Object.keys(errors).length === 1 && Object.hasOwn(errors, 'embeds');
}
function truncateDiscordMessageText(text: string): string {
  const [part] = splitDiscordText(text);
  return text.length > part.length ? `${part.slice(0, -1)}…` : text;
}

const DISCORD_PROGRESS_RETENTION_MS = 10 * 60_000;
const DISCORD_PROGRESS_MAX_KEYS = 5_000;
const DISCORD_PROGRESS_MAX_ATTEMPTS_PER_KEY = 16;

export class DiscordProgressIdentityLifecycle {
  private stateByProgressKey = new Map<string, ProgressKeyState>();
  private createTombstoneByProgressKey = new Map<string, CreateTombstone>();
  readonly mutationQueue = new DiscordProgressMutationQueue();
  private nextCreateAttemptSequence = 0;
  private nextGeneration = 0;

  retainedMessageId(routeKey: string, progressKey: string): string | undefined {
    const state = this.stateByProgressKey.get(
      discordProgressStateKey(routeKey, progressKey),
    );
    return state?.handle?.terminal ? state.handle.messageId : undefined;
  }

  retainedTerminalRender(
    routeKey: string,
    progressKey: string,
  ): RetainedTerminalRender | undefined {
    const state = this.stateByProgressKey.get(
      discordProgressStateKey(routeKey, progressKey),
    );
    const handle = state?.handle;
    if (!handle?.terminal || !handle.terminalPartMessageIds) return undefined;
    return {
      messageIds: handle.terminalPartMessageIds,
      ...(handle.terminalPayloadFingerprint
        ? { payloadFingerprint: handle.terminalPayloadFingerprint }
        : {}),
      ...(state?.ambiguousOverflowPayloadFingerprint
        ? {
            ambiguousPayloadFingerprint:
              state.ambiguousOverflowPayloadFingerprint,
          }
        : {}),
    };
  }

  retainMessageHandle(
    routeKey: string,
    progressKey: string,
    messageId: string,
    sequence = -1,
  ): void {
    const state = this.ensureState(routeKey, progressKey);
    if (state.handle && state.handle.sequence > sequence) return;
    state.handle = {
      messageId,
      sequence,
      terminal: true,
      terminalMultipart: false,
    };
    state.definitiveMissing = false;
    this.refreshRetention(state);
  }

  prepare(input: {
    routeKey: string;
    progressKey: string;
    text: string;
    options: ProgressUpdateOptions;
    hasHandle: boolean;
    activeMessageId?: string;
  }): {
    options: ProgressUpdateOptions;
    createAttempt?: CreateAttempt;
  } {
    const state = this.stateFor(input.routeKey, input.progressKey);
    const attachedIdentityIsDefinitivelyMissing =
      input.options.progressCardIdentity === input.progressKey &&
      state?.definitiveMissing === true;
    const options =
      input.options.progressCardIdentity && input.options.done
        ? {
            ...input.options,
            replaceOnly:
              input.options.replaceOnly ??
              !attachedIdentityIsDefinitivelyMissing,
          }
        : input.options;
    const hasRetainedTerminalHandle =
      options.done === true &&
      options.replaceOnly === true &&
      state?.handle?.terminal === true;
    const hasUsableHandle = input.hasHandle || hasRetainedTerminalHandle;
    const targetMessageId =
      input.activeMessageId ??
      (hasRetainedTerminalHandle ? state?.handle?.messageId : undefined);
    const parts = splitDiscordText(
      input.text || (options.done ? 'Done.' : ' '),
    );
    const willEdit =
      hasUsableHandle &&
      !(options.done && !input.text.trim() && !input.hasHandle);
    const willPost =
      (hasUsableHandle && parts.length > 1) ||
      (!hasUsableHandle &&
        options.replaceOnly !== true &&
        !(options.done && !input.text.trim()));
    if (!willEdit && !willPost) return { options };

    const current = this.ensureState(input.routeKey, input.progressKey);
    const createAttempt: CreateAttempt = {
      stateKey: discordProgressStateKey(input.routeKey, input.progressKey),
      routeKey: input.routeKey,
      progressKey: input.progressKey,
      sequence: this.nextCreateAttemptSequence++,
      generation: current.generation,
      providerSettlementDeadlineAt:
        Date.now() + DISCORD_PROGRESS_PROVIDER_SETTLEMENT_WINDOW_MS,
      done: options.done === true,
      consumedDefinitiveMissing:
        willPost && !hasUsableHandle && current.definitiveMissing,
      ...(targetMessageId ? { targetMessageId } : {}),
      ...(options.done &&
      hasUsableHandle &&
      (parts.length > 1 || state?.handle?.terminalMultipart)
        ? {
            overflowPayloadFingerprint: discordProgressPayloadFingerprint(
              input.text,
            ),
          }
        : {}),
    };
    if (options.done && willEdit) {
      for (const attempt of current.attempts.values()) {
        if (attempt.sequence < createAttempt.sequence) {
          attempt.invalidated = true;
          current.attempts.delete(attempt.sequence);
        }
      }
      if (
        current.ambiguitySequence !== undefined &&
        current.ambiguitySequence < createAttempt.sequence
      ) {
        current.ambiguitySequence = undefined;
      }
    }
    current.newestSequence = createAttempt.sequence;
    current.attempts.set(createAttempt.sequence, createAttempt);
    if (createAttempt.consumedDefinitiveMissing) {
      current.definitiveMissing = false;
    }
    this.pruneAttempts(current);
    if (!hasRetainedTerminalHandle) this.refreshRetention(current);
    return {
      options,
      createAttempt,
    };
  }

  reconcileCreateSettlement(input: {
    createAttempt: CreateAttempt;
    outcome: CreateAttemptOutcome;
    messageId?: string;
  }): CreateSettlement {
    const { createAttempt } = input;
    if (createAttempt.invalidated) {
      const current = this.stateByProgressKey.get(createAttempt.stateKey);
      return {
        ...(current?.handle ? { handle: current.handle } : {}),
        definitiveMissing: current?.definitiveMissing ?? false,
        clearActiveMessage: false,
        ...(input.messageId ? { invalidatedMessageId: input.messageId } : {}),
      };
    }
    let state = this.stateByProgressKey.get(createAttempt.stateKey);
    let restoredFromTombstone = false;
    if (!state) {
      const tombstone = this.createTombstoneByProgressKey.get(
        createAttempt.stateKey,
      );
      if (tombstone) {
        this.createTombstoneByProgressKey.delete(createAttempt.stateKey);
        state = { ...tombstone };
        this.stateByProgressKey.set(createAttempt.stateKey, state);
        this.enforceStateCap();
        restoredFromTombstone = true;
      } else {
        state = this.createState(
          createAttempt.routeKey,
          createAttempt.progressKey,
          createAttempt.generation,
        );
      }
    }

    const recordedAttempt =
      state.attempts.get(createAttempt.sequence) ?? createAttempt;
    const repairsRetainedTerminal =
      recordedAttempt.done &&
      state.handle?.terminal === true &&
      state.handle.messageId === recordedAttempt.targetMessageId;
    recordedAttempt.outcome = input.outcome;
    recordedAttempt.messageId = input.messageId;
    state.attempts.set(recordedAttempt.sequence, recordedAttempt);
    state.newestSequence = Math.max(
      state.newestSequence,
      recordedAttempt.sequence,
    );
    if (
      recordedAttempt.terminalBaseCompleted &&
      recordedAttempt.overflowPayloadFingerprint &&
      state.ambiguousOverflowPayloadFingerprint !==
        recordedAttempt.overflowPayloadFingerprint
    ) {
      state.ambiguousOverflowPayloadFingerprint = undefined;
    }
    if (input.outcome === 'ambiguous') {
      state.ambiguitySequence = Math.max(
        state.ambiguitySequence ?? -1,
        recordedAttempt.sequence,
      );
      if (
        recordedAttempt.overflowPostInvoked &&
        recordedAttempt.overflowPayloadFingerprint
      ) {
        state.ambiguousOverflowPayloadFingerprint =
          recordedAttempt.overflowPayloadFingerprint;
      }
    }
    const newestAttempt = state.attempts.get(state.newestSequence);
    const pendingAttempts = [...state.attempts.values()].filter(
      (attempt) => attempt.outcome === undefined,
    );
    const handleAttempts = [...state.attempts.values()].filter(
      (attempt) =>
        attempt.baseMessageId !== undefined ||
        (attempt.messageId !== undefined &&
          (attempt.outcome === 'landed' ||
            attempt.terminalPartMessageIds !== undefined)),
    );
    const highestHandleAttempt = handleAttempts.reduce<
      CreateAttempt | undefined
    >(
      (highest, attempt) =>
        !highest || attempt.sequence > highest.sequence ? attempt : highest,
      undefined,
    );
    const higherAttemptPending =
      highestHandleAttempt !== undefined &&
      pendingAttempts.some(
        (attempt) => attempt.sequence > highestHandleAttempt.sequence,
      );
    const handleAttemptIsPastAmbiguity =
      highestHandleAttempt !== undefined &&
      (state.ambiguitySequence === undefined ||
        highestHandleAttempt.sequence >= state.ambiguitySequence);

    if (
      highestHandleAttempt &&
      !higherAttemptPending &&
      handleAttemptIsPastAmbiguity &&
      (!state.handle || highestHandleAttempt.sequence >= state.handle.sequence)
    ) {
      const messageId = highestHandleAttempt.done
        ? (highestHandleAttempt.baseMessageId ??
          highestHandleAttempt.messageId!)
        : (highestHandleAttempt.messageId ??
          highestHandleAttempt.baseMessageId!);
      state.handle = {
        messageId,
        sequence: highestHandleAttempt.sequence,
        terminal:
          highestHandleAttempt.done &&
          (highestHandleAttempt.baseMessageId === undefined ||
            highestHandleAttempt.terminalBaseCompleted === true),
        terminalMultipart:
          highestHandleAttempt.terminalMultipartCompleted === true ||
          (state.handle?.messageId === messageId &&
            state.handle.terminalMultipart),
        ...(highestHandleAttempt.terminalPartMessageIds
          ? {
              terminalPartMessageIds:
                highestHandleAttempt.terminalPartMessageIds,
            }
          : {}),
        ...(highestHandleAttempt.terminalPayloadFingerprint
          ? {
              terminalPayloadFingerprint:
                highestHandleAttempt.terminalPayloadFingerprint,
            }
          : {}),
      };
    }
    const clearActiveMessage =
      input.outcome === 'ambiguous' &&
      recordedAttempt.targetMessageId === undefined &&
      recordedAttempt.baseMessageId === undefined &&
      (!state.handle || state.handle.sequence < recordedAttempt.sequence);
    if (clearActiveMessage) state.handle = undefined;

    const completedCreate = [...state.attempts.values()].some(
      (attempt) =>
        attempt.outcome === 'landed' || attempt.outcome === 'ambiguous',
    );
    state.definitiveMissing =
      state.handle === undefined &&
      state.ambiguitySequence === undefined &&
      !completedCreate &&
      pendingAttempts.length === 0 &&
      (newestAttempt?.outcome === 'definitively_missing' ||
        (newestAttempt?.outcome === 'skipped' &&
          newestAttempt.consumedDefinitiveMissing));

    this.pruneAttempts(state);
    if (restoredFromTombstone || !repairsRetainedTerminal) {
      this.refreshRetention(state);
    }
    return {
      ...(state.handle ? { handle: state.handle } : {}),
      definitiveMissing: state.definitiveMissing,
      clearActiveMessage,
    };
  }

  private stateFor(
    routeKey: string,
    progressKey: string,
  ): ProgressKeyState | undefined {
    const key = discordProgressStateKey(routeKey, progressKey);
    return (
      this.stateByProgressKey.get(key) ??
      this.createTombstoneByProgressKey.get(key)
    );
  }

  private ensureState(routeKey: string, progressKey: string): ProgressKeyState {
    const key = discordProgressStateKey(routeKey, progressKey);
    const existing = this.stateByProgressKey.get(key);
    if (existing) return existing;
    const tombstone = this.createTombstoneByProgressKey.get(key);
    if (tombstone) {
      this.createTombstoneByProgressKey.delete(key);
      const restored = { ...tombstone };
      this.stateByProgressKey.set(key, restored);
      this.enforceStateCap();
      this.refreshRetention(restored);
      return restored;
    }
    return this.createState(routeKey, progressKey, this.nextGeneration++);
  }

  private createState(
    routeKey: string,
    progressKey: string,
    generation: number,
  ): ProgressKeyState {
    const state: ProgressKeyState = {
      routeKey,
      progressKey,
      generation,
      newestSequence: -1,
      definitiveMissing: false,
      attempts: new Map(),
    };
    this.stateByProgressKey.set(
      discordProgressStateKey(routeKey, progressKey),
      state,
    );
    this.refreshRetention(state);
    this.enforceStateCap();
    return state;
  }

  private refreshRetention(state: ProgressKeyState): void {
    if (state.retentionTimer) clearTimeout(state.retentionTimer);
    const retentionTimer = setTimeout(() => {
      const key = discordProgressStateKey(state.routeKey, state.progressKey);
      if (this.stateByProgressKey.get(key) !== state) return;
      this.stateByProgressKey.delete(key);
      this.mutationQueue.releaseKey(key);
      if (
        state.definitiveMissing ||
        [...state.attempts.values()].some((attempt) => !attempt.outcome)
      ) {
        this.retainCreateTombstone(key, state);
      }
    }, DISCORD_PROGRESS_RETENTION_MS);
    retentionTimer.unref?.();
    state.retentionTimer = retentionTimer;
  }

  private pruneAttempts(state: ProgressKeyState): void {
    const highestHandleSequence = [...state.attempts.values()].reduce(
      (highest, attempt) =>
        attempt.baseMessageId ||
        (attempt.messageId &&
          (attempt.outcome === 'landed' ||
            attempt.terminalPartMessageIds !== undefined))
          ? Math.max(highest, attempt.sequence)
          : highest,
      -1,
    );
    for (const [sequence, attempt] of state.attempts) {
      if (attempt.outcome === undefined) continue;
      const isEligibleHeldLanding =
        sequence === highestHandleSequence &&
        (state.handle === undefined || sequence > state.handle.sequence);
      const isNewestSettlement = sequence === state.newestSequence;
      if (!isEligibleHeldLanding && !isNewestSettlement) {
        state.attempts.delete(sequence);
      }
    }

    while (state.attempts.size > DISCORD_PROGRESS_MAX_ATTEMPTS_PER_KEY) {
      const oldestPending = [...state.attempts.values()].find(
        (attempt) => attempt.outcome === undefined,
      );
      if (!oldestPending) break;
      oldestPending.invalidated = true;
      state.ambiguitySequence = Math.max(
        state.ambiguitySequence ?? -1,
        oldestPending.sequence,
      );
      state.attempts.delete(oldestPending.sequence);
    }
  }

  private enforceStateCap(): void {
    while (this.stateByProgressKey.size > DISCORD_PROGRESS_MAX_KEYS) {
      const oldest = this.stateByProgressKey.entries().next();
      if (oldest.done) return;
      const [key, state] = oldest.value;
      if (state.retentionTimer) clearTimeout(state.retentionTimer);
      this.stateByProgressKey.delete(key);
      this.mutationQueue.releaseKey(key);
      if (
        state.definitiveMissing ||
        [...state.attempts.values()].some((attempt) => !attempt.outcome)
      ) {
        this.retainCreateTombstone(key, state);
      }
    }
  }

  private retainCreateTombstone(key: string, state: ProgressKeyState): void {
    const { retentionTimer: _retentionTimer, ...tombstone } = state;
    this.createTombstoneByProgressKey.delete(key);
    this.createTombstoneByProgressKey.set(key, tombstone);
    while (this.createTombstoneByProgressKey.size > DISCORD_PROGRESS_MAX_KEYS) {
      const now = Date.now();
      let oldestEvictable: [string, CreateTombstone] | undefined;
      for (const entry of this.createTombstoneByProgressKey) {
        if (
          ![...entry[1].attempts.values()].some(
            (attempt) =>
              attempt.outcome === undefined &&
              attempt.invalidated !== true &&
              attempt.providerSettlementDeadlineAt > now,
          )
        ) {
          oldestEvictable = entry;
          break;
        }
      }
      if (!oldestEvictable) return;
      const [oldestKey, evicted] = oldestEvictable;
      for (const attempt of evicted?.attempts.values() ?? []) {
        if (!attempt.outcome) attempt.invalidated = true;
      }
      this.createTombstoneByProgressKey.delete(oldestKey);
    }
  }
}

async function executeDiscordProgressUpdateForRoute(input: {
  routeKey: string;
  key: string;
  activeMessages: Map<string, string>;
  identityLifecycle: DiscordProgressIdentityLifecycle;
  text: string;
  options: ProgressUpdateOptions;
  post: DiscordProgressPost;
  edit: DiscordProgressEdit;
  delete?: (messageId: string, signal?: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  isAbandoned: () => boolean;
}): Promise<boolean> {
  const prepared = input.identityLifecycle.prepare({
    routeKey: input.routeKey,
    progressKey: input.key,
    text: input.text,
    options: input.options,
    hasHandle: input.activeMessages.has(input.key),
    activeMessageId: input.activeMessages.get(input.key),
  });
  let outcome: CreateAttemptOutcome = 'skipped';
  let createdMessageId: string | undefined;
  const mutationSettlement = {
    mutationInvoked: false,
    mutationCompleted: false,
  };
  let editedBaseMessageId: string | undefined;
  const retainedTerminalRender =
    prepared.options.done === true && prepared.options.replaceOnly === true
      ? input.identityLifecycle.retainedTerminalRender(
          input.routeKey,
          input.key,
        )
      : undefined;
  let terminalMultipartCompleted = retainedTerminalRender !== undefined;
  let terminalPartMessageIds = retainedTerminalRender?.messageIds;
  let terminalPayloadFingerprint: string | undefined;
  try {
    const result = await dispatchDiscordProgressUpdate({
      ...input,
      options: prepared.options,
      retainedMessageId:
        prepared.options.done === true && prepared.options.replaceOnly === true
          ? input.identityLifecycle.retainedMessageId(input.routeKey, input.key)
          : undefined,
      retainedTerminalRender,
      recordEditedBase: (messageId) => {
        editedBaseMessageId = messageId;
      },
      edit: async (messageId, body) => {
        mutationSettlement.mutationInvoked = true;
        mutationSettlement.mutationCompleted = false;
        await input.edit(messageId, body, input.signal);
        mutationSettlement.mutationCompleted = true;
      },
      post: createTrackedDiscordProgressPost({
        createAttempt: prepared.createAttempt,
        post: (text, components) => input.post(text, components, input.signal),
        settlement: mutationSettlement,
      }),
    });
    outcome = result.createOutcome ?? 'skipped';
    createdMessageId = result.createdMessageId;
    terminalMultipartCompleted = result.terminalMultipartCompleted === true;
    terminalPartMessageIds = result.terminalPartMessageIds;
    terminalPayloadFingerprint = result.terminalPayloadFingerprint;
    return result.accepted;
  } finally {
    if (prepared.createAttempt && !input.isAbandoned()) {
      const settledTerminalPartMessageIds =
        terminalPartMessageIds ??
        (prepared.options.done === true &&
        editedBaseMessageId !== undefined &&
        prepared.createAttempt.overflowPayloadFingerprint
          ? [editedBaseMessageId]
          : undefined);
      prepared.createAttempt.baseMessageId = editedBaseMessageId;
      prepared.createAttempt.terminalBaseCompleted =
        prepared.options.done === true && editedBaseMessageId !== undefined;
      prepared.createAttempt.terminalMultipartCompleted =
        terminalMultipartCompleted ||
        settledTerminalPartMessageIds !== undefined;
      prepared.createAttempt.terminalPartMessageIds =
        settledTerminalPartMessageIds;
      prepared.createAttempt.terminalPayloadFingerprint =
        terminalPayloadFingerprint;
      const settlement = input.identityLifecycle.reconcileCreateSettlement({
        createAttempt: prepared.createAttempt,
        outcome: mutationSettlement.mutationCompleted
          ? outcome
          : mutationSettlement.mutationInvoked
            ? 'ambiguous'
            : 'skipped',
        ...(createdMessageId ? { messageId: createdMessageId } : {}),
      });
      if (settlement.invalidatedMessageId) {
        await input
          .delete?.(settlement.invalidatedMessageId, input.signal)
          .catch(() => undefined);
      }
      if (settlement.clearActiveMessage || settlement.handle?.terminal) {
        input.activeMessages.delete(input.key);
      } else if (settlement.handle) {
        input.activeMessages.set(input.key, settlement.handle.messageId);
      }
    }
  }
}

export async function sendDiscordProgressUpdateForRoute(input: {
  routeKey: string;
  key: string;
  activeMessages: Map<string, string>;
  identityLifecycle: DiscordProgressIdentityLifecycle;
  text: string;
  options: ProgressUpdateOptions;
  post: DiscordProgressPost;
  edit: DiscordProgressEdit;
  delete?: (messageId: string, signal?: AbortSignal) => Promise<void>;
}): Promise<boolean> {
  return input.identityLifecycle.mutationQueue.enqueue(
    input.routeKey,
    input.key,
    (signal, isAbandoned) =>
      executeDiscordProgressUpdateForRoute({ ...input, signal, isAbandoned }),
  );
}
