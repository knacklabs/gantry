import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import type { ProgressChannelSender } from './group-progress-channel-sender.js';

const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
const LIFECYCLE_HOOK_TIMEOUT_MS = 2_000;
export const STALL_HEARTBEAT_THRESHOLD_MS = 180_000;

export type GroupLivenessPhase =
  | 'active'
  | 'delivering'
  | 'waiting'
  | 'stalled'
  | 'terminal';

type GroupLivenessLogger = {
  debug(metadata: Record<string, unknown>, message: string): void;
};

type ReactionTarget = { jid: string; messageRef: string; threadId?: string };
type GroupLivenessPauseReason = 'waiting-for-user' | 'turn-complete';

export function createGroupTurnTypingSender(input: {
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  chatJid: string;
  providerAccountId?: string;
  activeThreadId?: string;
}) {
  const options =
    input.providerAccountId || input.activeThreadId
      ? {
          ...(input.providerAccountId
            ? { providerAccountId: input.providerAccountId }
            : {}),
          ...(input.activeThreadId ? { threadId: input.activeThreadId } : {}),
        }
      : undefined;
  return (isTyping: boolean) =>
    options
      ? input.channelRuntime.setTyping(input.chatJid, isTyping, options)
      : input.channelRuntime.setTyping(input.chatJid, isTyping);
}

export class GroupLivenessController {
  private phase: GroupLivenessPhase = 'active';
  private lastOutputAt = Date.now();
  private stallNoticeClaimed = false;
  private stallRetryNotBefore = 0;
  private lifecycleEpoch = 0;
  private visibleDeliveryStartedAt = 0;
  private deliveryBeganStalled = false;
  private deliveryPauseReason: GroupLivenessPauseReason | undefined;
  private pauseReason: GroupLivenessPauseReason | undefined;
  private firstReactionStarted = false;
  private firstVisibleOutputNotified = false;
  private typingInFlight:
    | { value: boolean; promise: Promise<void> }
    | undefined;
  private queuedTyping:
    | {
        value: boolean;
        promise: Promise<void>;
        resolve: () => void;
      }
    | undefined;
  private terminalPromise: Promise<void> | undefined;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly input: {
      supportsProgress: boolean;
      chatJid: string;
      providerAccountId?: string;
      activeThreadId?: string;
      groupName: string;
      channelRuntime: GroupProcessingDeps['channelRuntime'];
      buildProgressOptions: (options: {
        done?: boolean;
        replaceOnly?: boolean;
      }) => ProgressUpdateOptions;
      sendProgressToChannel: ProgressChannelSender;
      onFirstProgress?: (target: ReactionTarget) => Promise<void> | void;
      onFirstVisibleOutput?: () => Promise<void> | void;
      onTerminal?: () => Promise<void> | void;
      log: GroupLivenessLogger;
    },
  ) {
    this.heartbeatTimer = setInterval(
      () => this.onHeartbeat(),
      TYPING_HEARTBEAT_INTERVAL_MS,
    );
  }

  currentPhase(): GroupLivenessPhase {
    return this.phase;
  }

  start(target: ReactionTarget | null): void {
    this.phase = 'active';
    this.refreshTyping();
    if (!target || this.firstReactionStarted) return;
    this.firstReactionStarted = true;
    this.detachBoundedHook(
      () => this.input.onFirstProgress?.(target),
      'First reaction admission timed out',
      'First reaction admission failed',
    );
  }

  resetStallEpoch(): void {
    this.lastOutputAt = Date.now();
    this.stallRetryNotBefore = 0;
    this.clearStallClaim();
  }

  pause(): boolean {
    return this.pauseFor('waiting-for-user');
  }

  pauseForTurnComplete(): void {
    this.pauseFor('turn-complete');
  }

  private pauseFor(reason: GroupLivenessPauseReason): boolean {
    if (
      this.phase === 'terminal' ||
      (this.phase === 'waiting' && this.pauseReason === reason)
    ) {
      return false;
    }
    this.phase = 'waiting';
    this.pauseReason = reason;
    this.invalidatePendingStallWork();
    void this.setTyping(false);
    return true;
  }

  resume(): void {
    if (this.phase === 'terminal') return;
    this.phase = 'active';
    this.deliveryPauseReason = undefined;
    this.pauseReason = undefined;
    this.resetStallEpoch();
    this.refreshTyping();
  }

  resumeWaitingForUser(): boolean {
    if (this.pauseReason !== 'waiting-for-user') return false;
    this.resume();
    return true;
  }

  async beginVisibleDelivery(): Promise<void> {
    if (this.phase === 'terminal') return;
    this.deliveryPauseReason =
      this.phase === 'waiting' ? this.pauseReason : undefined;
    this.deliveryBeganStalled =
      this.phase === 'stalled' ||
      Date.now() - this.lastOutputAt >= STALL_HEARTBEAT_THRESHOLD_MS;
    this.phase = 'delivering';
    this.visibleDeliveryStartedAt = Date.now();
    this.invalidatePendingStallWork();
    await this.input.sendProgressToChannel.beforeVisibleDelivery(
      this.input.buildProgressOptions({ replaceOnly: true }),
    );
  }

  async finishVisibleDelivery(delivered: boolean): Promise<void> {
    if (this.phase === 'terminal') return;
    const deliveryPauseReason =
      this.phase === 'waiting' ? this.pauseReason : this.deliveryPauseReason;
    this.deliveryPauseReason = undefined;
    const recoveredFromStall =
      this.deliveryBeganStalled || this.phase === 'stalled';
    this.deliveryBeganStalled = false;
    if (!delivered) {
      if (deliveryPauseReason) {
        this.phase = 'waiting';
        this.pauseReason = deliveryPauseReason;
      } else {
        this.phase =
          recoveredFromStall ||
          Date.now() - this.lastOutputAt >= STALL_HEARTBEAT_THRESHOLD_MS
            ? 'stalled'
            : 'active';
      }
      return;
    }

    this.phase = deliveryPauseReason ? 'waiting' : 'active';
    this.pauseReason = deliveryPauseReason;
    this.lifecycleEpoch += 1;
    this.resetStallEpoch();
    this.input.sendProgressToChannel.recordVisibleDelivery(
      'Done.',
      this.input.buildProgressOptions({ done: true }),
    );
    if (recoveredFromStall && !deliveryPauseReason) this.refreshTyping();
    if (this.firstVisibleOutputNotified) return;
    this.firstVisibleOutputNotified = true;
    await this.runBoundedHook(
      this.input.onFirstVisibleOutput,
      'First visible output hook timed out',
      'First visible output hook failed',
    );
  }

  terminal(): Promise<void> {
    if (this.terminalPromise) return this.terminalPromise;
    this.phase = 'terminal';
    this.pauseReason = undefined;
    clearInterval(this.heartbeatTimer);
    this.invalidatePendingStallWork();
    this.terminalPromise = this.setTyping(false);
    this.detachBoundedHook(
      this.input.onTerminal,
      'Terminal reaction cleanup timed out',
      'Terminal reaction cleanup failed',
    );
    return this.terminalPromise;
  }

  private onHeartbeat(): void {
    if (this.phase === 'terminal' || this.phase === 'waiting') return;
    if (this.phase === 'delivering') {
      if (
        Date.now() - this.visibleDeliveryStartedAt <
        STALL_HEARTBEAT_THRESHOLD_MS
      ) {
        if (!this.deliveryBeganStalled) this.refreshTyping();
        return;
      }
      this.phase = 'stalled';
    } else if (
      this.phase === 'active' &&
      Date.now() - this.lastOutputAt >= STALL_HEARTBEAT_THRESHOLD_MS
    ) {
      this.phase = 'stalled';
    }

    if (this.phase === 'active') {
      this.refreshTyping();
      return;
    }
    if (
      this.phase !== 'stalled' ||
      Date.now() < this.stallRetryNotBefore ||
      this.stallNoticeClaimed
    ) {
      return;
    }

    this.stallNoticeClaimed = true;
    const requestEpoch = this.lifecycleEpoch;
    void this.sendStallProgress().then(
      (landed) => {
        if (this.phase !== 'stalled' || requestEpoch !== this.lifecycleEpoch) {
          return;
        }
        if (landed) return;
        this.stallRetryNotBefore = Date.now() + STALL_HEARTBEAT_THRESHOLD_MS;
        this.clearStallClaim();
        this.input.log.debug(
          { group: this.input.groupName, landed: false },
          'Failed to send stalled progress heartbeat',
        );
      },
      (err: unknown) => {
        if (this.phase !== 'stalled' || requestEpoch !== this.lifecycleEpoch) {
          return;
        }
        this.input.log.debug(
          { err, group: this.input.groupName },
          'Failed to send stalled progress heartbeat',
        );
      },
    );
  }

  private sendStallProgress(): Promise<boolean> {
    return this.input.supportsProgress
      ? this.input.sendProgressToChannel(
          'Still working',
          this.input.buildProgressOptions({ replaceOnly: true }),
        )
      : Promise.resolve(false);
  }

  private invalidatePendingStallWork(): void {
    this.lifecycleEpoch += 1;
    this.stallRetryNotBefore = 0;
    this.clearStallClaim();
    this.input.sendProgressToChannel.cancelPendingStallNotices();
  }

  private clearStallClaim(): void {
    this.stallNoticeClaimed = false;
  }

  private refreshTyping(): void {
    void this.setTyping(true);
  }

  private setTyping(isTyping: boolean): Promise<void> {
    if (!this.typingInFlight) return this.startTypingWrite(isTyping);
    if (!this.queuedTyping && this.typingInFlight.value === isTyping) {
      return this.typingInFlight.promise;
    }
    if (this.queuedTyping) {
      this.queuedTyping.value = isTyping;
      return this.queuedTyping.promise;
    }
    let resolve!: () => void;
    const promise = new Promise<void>((settled) => {
      resolve = settled;
    });
    this.queuedTyping = { value: isTyping, promise, resolve };
    return promise;
  }

  private startTypingWrite(isTyping: boolean): Promise<void> {
    const promise = this.writeTyping(isTyping)
      .catch((err) => {
        this.input.log.debug(
          { err, group: this.input.groupName },
          `Failed to ${isTyping ? 'refresh' : 'stop'} typing heartbeat`,
        );
      })
      .then(() => {
        if (this.typingInFlight?.promise !== promise) return;
        this.typingInFlight = undefined;
        const queued = this.queuedTyping;
        this.queuedTyping = undefined;
        if (!queued) return;
        void this.startTypingWrite(queued.value).then(queued.resolve);
      });
    this.typingInFlight = { value: isTyping, promise };
    return promise;
  }

  private writeTyping(isTyping: boolean): Promise<void> {
    const options =
      this.input.providerAccountId || this.input.activeThreadId
        ? {
            ...(this.input.providerAccountId
              ? { providerAccountId: this.input.providerAccountId }
              : {}),
            ...(this.input.activeThreadId
              ? { threadId: this.input.activeThreadId }
              : {}),
          }
        : undefined;
    return options
      ? this.input.channelRuntime.setTyping(
          this.input.chatJid,
          isTyping,
          options,
        )
      : this.input.channelRuntime.setTyping(this.input.chatJid, isTyping);
  }

  private detachBoundedHook(
    hook: (() => Promise<void> | void) | undefined,
    timeoutMessage: string,
    failureMessage: string,
  ): void {
    void this.runBoundedHook(hook, timeoutMessage, failureMessage);
  }

  private async runBoundedHook(
    hook: (() => Promise<void> | void) | undefined,
    timeoutMessage: string,
    failureMessage: string,
  ): Promise<void> {
    if (!hook) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      Promise.resolve()
        .then(hook)
        .then(
          () => true,
          (err) => {
            this.input.log.debug(
              { err, group: this.input.groupName },
              failureMessage,
            );
            return true;
          },
        ),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), LIFECYCLE_HOOK_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!completed) {
      this.input.log.debug({ group: this.input.groupName }, timeoutMessage);
    }
  }
}
