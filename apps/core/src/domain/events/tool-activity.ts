import type { RuntimeEvent } from './events.js';
import { RUNTIME_EVENT_TYPES } from './runtime-event-types.js';

export type ToolActivityOutcome = 'success' | 'failure';
export type ToolActivityFamily = 'generic' | 'browser' | 'capability';

export interface TerminalToolActivity {
  invocationId: string;
  tool: string;
  family: ToolActivityFamily;
  outcome: ToolActivityOutcome;
  authoritative: boolean;
  seq?: number;
  detail?: string;
}

export function terminalToolActivityPayload(input: {
  invocationId: string;
  tool: string;
  family?: ToolActivityFamily;
  outcome: ToolActivityOutcome;
  authoritative?: boolean;
  seq?: number;
  detail?: string;
}): Record<string, unknown> {
  return {
    phase: input.outcome,
    tool: input.tool,
    ...(input.family && input.family !== 'generic'
      ? { family: input.family }
      : {}),
    ok: input.outcome === 'success',
    invocationId: input.invocationId,
    authoritative: input.authoritative === true,
    ...(validSequence(input.seq) ? { seq: input.seq } : {}),
    ...(input.detail?.trim() ? { detail: input.detail.trim() } : {}),
  };
}

export function parseTerminalToolActivity(
  event: Pick<RuntimeEvent, 'eventType' | 'correlationId' | 'payload'>,
): TerminalToolActivity | null {
  if (
    event.eventType !== RUNTIME_EVENT_TYPES.TOOL_ACTIVITY ||
    !event.payload ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  ) {
    return null;
  }
  const payload = event.payload as Record<string, unknown>;
  const outcome = payload.phase;
  const tool = stringValue(payload.tool);
  const invocationId =
    stringValue(event.correlationId) ?? stringValue(payload.invocationId);
  if (
    (outcome !== 'success' && outcome !== 'failure') ||
    !tool ||
    !invocationId ||
    payload.ok !== (outcome === 'success')
  ) {
    return null;
  }
  return {
    invocationId,
    tool,
    family: toolActivityFamily(payload.family),
    outcome,
    authoritative: payload.authoritative === true,
    ...(validSequence(payload.seq) ? { seq: payload.seq } : {}),
    ...(stringValue(payload.detail)
      ? { detail: stringValue(payload.detail) }
      : {}),
  };
}

export function privateToolActivityInvocationIdFromResult(
  value: unknown,
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const meta = (value as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return undefined;
  }
  return stringValue((meta as Record<string, unknown>).invocationId);
}

export function withPrivateToolActivityInvocationId<T extends object>(
  result: T,
  invocationId: string | undefined,
): T {
  const id = stringValue(invocationId);
  if (!id) return result;
  const existingDescriptor = Object.getOwnPropertyDescriptor(result, '_meta');
  const existingMeta = existingDescriptor?.value;
  const descriptors = Object.getOwnPropertyDescriptors(result);
  delete descriptors._meta;
  const clone = (
    Array.isArray(result)
      ? [...result]
      : Object.defineProperties(
          Object.create(Object.getPrototypeOf(result)),
          descriptors,
        )
  ) as T;
  const meta =
    existingMeta &&
    typeof existingMeta === 'object' &&
    !Array.isArray(existingMeta)
      ? Object.defineProperties(
          Object.create(Object.getPrototypeOf(existingMeta)),
          Object.getOwnPropertyDescriptors(existingMeta),
        )
      : {};
  Object.defineProperty(meta, 'invocationId', {
    value: id,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(clone, '_meta', {
    value: meta,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return clone;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function toolActivityFamily(value: unknown): ToolActivityFamily {
  return value === 'browser' || value === 'capability' ? value : 'generic';
}
