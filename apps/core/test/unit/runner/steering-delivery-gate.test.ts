import { describe, expect, it, vi } from 'vitest';

import { SteeringDeliveryGate } from '@core/adapters/llm/anthropic-claude-agent/runner/steering-delivery-gate.js';

describe('SteeringDeliveryGate', () => {
  it('buffers steering until a turn boundary', () => {
    const deliver = vi.fn();
    const gate = new SteeringDeliveryGate(deliver);

    expect(gate.accept('first')).toBe('buffered');
    expect(gate.accept('second')).toBe('buffered');
    expect(gate.pendingCount()).toBe(2);
    expect(deliver).not.toHaveBeenCalled();

    expect(gate.markTurnBoundary()).toBe(2);
    expect(gate.pendingCount()).toBe(0);
    expect(deliver.mock.calls.map(([text]) => text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('delivers immediately while parked at an idle boundary', () => {
    const deliver = vi.fn();
    const gate = new SteeringDeliveryGate(deliver);

    expect(gate.markTurnBoundary()).toBe(0);
    expect(gate.accept('now')).toBe('delivered');

    expect(deliver).toHaveBeenCalledWith('now');
  });

  it('drops buffered and future steering after close', () => {
    const deliver = vi.fn();
    const gate = new SteeringDeliveryGate(deliver);

    expect(gate.accept('buffered')).toBe('buffered');
    gate.close();

    expect(gate.markTurnBoundary()).toBe(0);
    expect(gate.accept('late')).toBe('closed');
    expect(deliver).not.toHaveBeenCalled();
  });
});
