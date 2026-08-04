export interface ManualClockMarker {
  readonly name: string;
  readonly atMs: number;
}

export interface ManualClock {
  nowMs(): number;
  advanceMs(durationMs: number): number;
  mark(name: string): ManualClockMarker;
  markers(): readonly ManualClockMarker[];
}

export function createManualClock(startMs = 0): ManualClock {
  if (!Number.isFinite(startMs)) {
    throw new Error('Manual clock start must be finite');
  }

  let currentMs = startMs;
  const recordedMarkers: ManualClockMarker[] = [];

  return {
    nowMs: () => currentMs,
    advanceMs(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error(
          'Manual clock advances must be finite and non-negative',
        );
      }
      const nextMs = currentMs + durationMs;
      if (!Number.isFinite(nextMs)) {
        throw new Error('Manual clock result must be finite');
      }
      currentMs = nextMs;
      return currentMs;
    },
    mark(name) {
      const marker = Object.freeze({ name, atMs: currentMs });
      recordedMarkers.push(marker);
      return marker;
    },
    markers: () =>
      Object.freeze(recordedMarkers.map((marker) => ({ ...marker }))),
  };
}

export const RESPONSE_LATENCY_OPERATION_NAMES = [
  'postgres_statements',
  'postgres_transactions',
  'get_messages_since_calls',
  'provider_history_calls',
  'memory_hydrate_calls',
  'list_enabled_skills_calls',
  'get_skill_calls',
  'list_tool_bindings_calls',
  'get_tool_calls',
  'list_mcp_bindings_calls',
  'get_mcp_server_calls',
  's3_list_calls',
  's3_get_calls',
  'mcp_connect_calls',
  'mcp_list_tools_calls',
] as const;

export interface OperationCounter {
  increment(operation: string, count?: number): number;
  get(operation: string): number;
  snapshot(): Readonly<Record<string, number>>;
}

export function createOperationCounter(): OperationCounter {
  const counts = new Map<string, number>(
    RESPONSE_LATENCY_OPERATION_NAMES.map((name) => [name, 0]),
  );

  return {
    increment(operation, count = 1) {
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(
          'Operation counter increments must be non-negative integers',
        );
      }
      const next = (counts.get(operation) ?? 0) + count;
      counts.set(operation, next);
      return next;
    },
    get: (operation) => counts.get(operation) ?? 0,
    snapshot: () => Object.freeze(Object.fromEntries(counts)),
  };
}

export const RESPONSE_LATENCY_BOUNDARIES = [
  'ingress_receipt',
  'metadata_persistence',
  'message_commit',
  'admission_notification',
  'replay_load',
  'conversation_local_load',
  'provider_history_hydration',
  'provider_history_persistence',
  'provisional_session_context',
  'final_session_context',
  'memory_hydration',
  'access_row_load',
  'access_projection',
  'skill_artifact_projection',
  'mcp_materialization',
  'mcp_connect',
  'mcp_discovery',
  'adapter_prepare',
  'provider_first_byte',
  'channel_first_visible_delivery',
] as const;

export type ResponseLatencyBoundary =
  (typeof RESPONSE_LATENCY_BOUNDARIES)[number];

export interface BoundaryDelayInjector {
  setDelayMs(boundary: ResponseLatencyBoundary, durationMs: number): void;
  wait(boundary: ResponseLatencyBoundary): Promise<void>;
  snapshot(): Readonly<Record<ResponseLatencyBoundary, number>>;
}

export function createBoundaryDelayInjector(input: {
  clock: ManualClock;
}): BoundaryDelayInjector {
  const delays = new Map<ResponseLatencyBoundary, number>(
    RESPONSE_LATENCY_BOUNDARIES.map((boundary) => [boundary, 0]),
  );

  return {
    setDelayMs(boundary, durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new Error('Boundary delays must be finite and non-negative');
      }
      delays.set(boundary, durationMs);
    },
    async wait(boundary) {
      input.clock.advanceMs(delays.get(boundary) ?? 0);
    },
    snapshot: () =>
      Object.freeze(
        Object.fromEntries(delays) as Record<ResponseLatencyBoundary, number>,
      ),
  };
}

export interface BarrierSnapshot {
  readonly arrivals: number;
  readonly active: number;
  readonly completed: number;
  readonly maximumActive: number;
  readonly allArrived: boolean;
}

export interface BarrierParticipant {
  readonly completed: Promise<void>;
  release(): void;
}

export interface DeterministicBarrier {
  arrive(): BarrierParticipant;
  waitForArrivals(count: number): Promise<void>;
  waitForAll(): Promise<void>;
  snapshot(): BarrierSnapshot;
}

export function createDeterministicBarrier(
  expectedArrivals: number,
): DeterministicBarrier {
  if (!Number.isInteger(expectedArrivals) || expectedArrivals < 1) {
    throw new Error('Barrier expected arrivals must be a positive integer');
  }

  let arrivals = 0;
  let active = 0;
  let completed = 0;
  let maximumActive = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];

  const notifyWaiters = () => {
    for (const waiter of waiters.splice(0)) {
      if (arrivals >= waiter.count) {
        waiter.resolve();
      } else {
        waiters.push(waiter);
      }
    }
  };
  const waitForArrivals = (count: number): Promise<void> => {
    if (!Number.isInteger(count) || count < 0 || count > expectedArrivals) {
      throw new Error(
        'Barrier arrival wait must be between zero and expected arrivals',
      );
    }
    if (arrivals >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      waiters.push({ count, resolve });
    });
  };

  return {
    arrive() {
      if (arrivals >= expectedArrivals) {
        throw new Error('Barrier received more arrivals than expected');
      }
      let resolveCompleted: (() => void) | undefined;
      const participantCompleted = new Promise<void>((resolve) => {
        resolveCompleted = resolve;
      });

      arrivals += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      notifyWaiters();
      let released = false;

      return {
        completed: participantCompleted,
        release() {
          if (released) return;
          released = true;
          active -= 1;
          completed += 1;
          resolveCompleted?.();
        },
      };
    },
    waitForArrivals,
    waitForAll: () => waitForArrivals(expectedArrivals),
    snapshot: () =>
      Object.freeze({
        arrivals,
        active,
        completed,
        maximumActive,
        allArrived: arrivals >= expectedArrivals,
      }),
  };
}

export type ResponseLatencyFrame =
  | { readonly kind: 'session_init'; readonly sessionCreated: boolean }
  | { readonly kind: 'runtime_event'; readonly eventType: string }
  | { readonly kind: 'progress'; readonly status: string }
  | { readonly kind: 'typing'; readonly active: boolean }
  | {
      readonly kind: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly kind: 'terminal'; readonly result: string | null }
  | { readonly kind: 'content_part'; readonly text: string }
  | { readonly kind: 'content_chunk'; readonly text: string };

export function isContentBearingFrame(frame: ResponseLatencyFrame): boolean {
  switch (frame.kind) {
    case 'content_part':
    case 'content_chunk':
      return (
        frame.text.replace(
          /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}]/gu,
          '',
        ).length > 0
      );
    default:
      return false;
  }
}

export interface ScriptedFakeStreamingModel {
  stream(
    onFrame: (frame: ResponseLatencyFrame) => void | Promise<void>,
  ): Promise<void>;
}

export function createScriptedFakeStreamingModel(input: {
  preContentFrames?: readonly ResponseLatencyFrame[];
  contentFrame: ResponseLatencyFrame;
  delay: () => void | Promise<void>;
}): ScriptedFakeStreamingModel {
  if (!isContentBearingFrame(input.contentFrame)) {
    throw new Error(
      'Scripted fake streaming model requires one content-bearing frame',
    );
  }
  if (input.preContentFrames?.some(isContentBearingFrame)) {
    throw new Error(
      'Scripted fake streaming model pre-content frames must be non-content',
    );
  }

  return {
    async stream(onFrame) {
      for (const frame of input.preContentFrames ?? []) {
        await onFrame(frame);
      }
      await input.delay();
      await onFrame(input.contentFrame);
    },
  };
}

export type DeliverySettlement =
  | 'completed'
  | 'delivery_incomplete'
  | 'not_delivered'
  | 'rejected';

export interface DeliveryFrameObservation {
  readonly kind: ResponseLatencyFrame['kind'];
  readonly contentBearing: boolean;
  readonly delivered: boolean;
}

export interface DeliveryAttemptSnapshot {
  readonly id: string;
  readonly settlement?: DeliverySettlement;
  readonly frames: readonly DeliveryFrameObservation[];
  readonly candidateAtMs?: number;
  readonly publishedAtMs?: number;
}

export interface DeliveryAttempt {
  observe(frame: ResponseLatencyFrame, input: { delivered: boolean }): void;
  settle(settlement: Exclude<DeliverySettlement, 'rejected'>): void;
  reject(): void;
  snapshot(): DeliveryAttemptSnapshot;
}

export interface FakeChannelDeliveryProbe {
  beginAttempt(id: string): DeliveryAttempt;
  firstContentAtMs(): number | undefined;
  attempts(): readonly DeliveryAttemptSnapshot[];
}

export function createFakeChannelDeliveryProbe(input: {
  nowMs: () => number;
}): FakeChannelDeliveryProbe {
  let firstContentAtMs: number | undefined;
  const attempts: Array<{
    id: string;
    settlement?: DeliverySettlement;
    frames: DeliveryFrameObservation[];
    candidateAtMs?: number;
    publishedAtMs?: number;
  }> = [];

  const snapshotAttempt = (
    attempt: (typeof attempts)[number],
  ): DeliveryAttemptSnapshot =>
    Object.freeze({
      id: attempt.id,
      ...(attempt.settlement ? { settlement: attempt.settlement } : {}),
      frames: Object.freeze(attempt.frames.map((frame) => ({ ...frame }))),
      ...(attempt.candidateAtMs === undefined
        ? {}
        : { candidateAtMs: attempt.candidateAtMs }),
      ...(attempt.publishedAtMs === undefined
        ? {}
        : { publishedAtMs: attempt.publishedAtMs }),
    });

  return {
    beginAttempt(id) {
      const attempt: (typeof attempts)[number] = { id, frames: [] };
      attempts.push(attempt);

      const finish = (settlement: DeliverySettlement) => {
        if (attempt.settlement) {
          throw new Error(`Delivery attempt ${id} already settled`);
        }
        attempt.settlement = settlement;
        if (
          attempt.candidateAtMs !== undefined &&
          (settlement === 'completed' || settlement === 'delivery_incomplete')
        ) {
          attempt.publishedAtMs = attempt.candidateAtMs;
          firstContentAtMs =
            firstContentAtMs === undefined
              ? attempt.candidateAtMs
              : Math.min(firstContentAtMs, attempt.candidateAtMs);
        }
      };

      return {
        observe(frame, observation) {
          if (attempt.settlement) {
            throw new Error(`Delivery attempt ${id} already settled`);
          }
          const contentBearing = isContentBearingFrame(frame);
          attempt.frames.push(
            Object.freeze({
              kind: frame.kind,
              contentBearing,
              delivered: observation.delivered,
            }),
          );
          if (
            attempt.candidateAtMs === undefined &&
            contentBearing &&
            observation.delivered
          ) {
            attempt.candidateAtMs = input.nowMs();
          }
        },
        settle: finish,
        reject: () => finish('rejected'),
        snapshot: () => snapshotAttempt(attempt),
      };
    },
    firstContentAtMs: () => firstContentAtMs,
    attempts: () => Object.freeze(attempts.map(snapshotAttempt)),
  };
}

export interface ResponseLatencyHarness {
  readonly clock: ManualClock;
  readonly operations: OperationCounter;
  readonly delays: BoundaryDelayInjector;
  readonly channel: FakeChannelDeliveryProbe;
  createBarrier(expectedArrivals: number): DeterministicBarrier;
}

export function createResponseLatencyHarness(input?: {
  startMs?: number;
}): ResponseLatencyHarness {
  const clock = createManualClock(input?.startMs);
  return {
    clock,
    operations: createOperationCounter(),
    delays: createBoundaryDelayInjector({ clock }),
    channel: createFakeChannelDeliveryProbe({ nowMs: clock.nowMs }),
    createBarrier: createDeterministicBarrier,
  };
}
