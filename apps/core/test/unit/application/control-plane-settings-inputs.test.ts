import { describe, expect, it } from 'vitest';

import {
  controlPlaneJobStatus,
  controlPlaneMemoryStatus,
  controlPlaneProviderInputs,
  type ControlPlaneSettingsInputView,
} from '@core/application/control-plane/control-plane-settings-inputs.js';

describe('controlPlaneProviderInputs', () => {
  it('marks a provider enabled in settings with a matching connection as ready', () => {
    const view: ControlPlaneSettingsInputView = {
      providers: { telegram: { enabled: true } },
      providerConnections: { telegram_default: { provider: 'telegram' } },
    };
    expect(controlPlaneProviderInputs(view)).toEqual([
      { id: 'telegram', label: 'telegram', ready: true },
    ]);
  });

  it('marks a provider with a connection but undefined in settings as ready', () => {
    // providers[id] === undefined satisfies the ready predicate, and the
    // connection is included via connectionProviders.
    const view: ControlPlaneSettingsInputView = {
      providers: {},
      providerConnections: { slack_default: { provider: 'slack' } },
    };
    expect(controlPlaneProviderInputs(view)).toEqual([
      { id: 'slack', label: 'slack', ready: true },
    ]);
  });

  it('includes a provider enabled in settings without a connection as not ready', () => {
    // Enabled satisfies the filter, but ready is false because no connection
    // exists (connectionProviders.has(id) is false).
    const view: ControlPlaneSettingsInputView = {
      providers: { telegram: { enabled: true } },
      providerConnections: {},
    };
    expect(controlPlaneProviderInputs(view)).toEqual([
      { id: 'telegram', label: 'telegram', ready: false },
    ]);
  });

  it('excludes a provider present but not enabled and without a connection', () => {
    const view: ControlPlaneSettingsInputView = {
      providers: { telegram: { enabled: false } },
      providerConnections: {},
    };
    expect(controlPlaneProviderInputs(view)).toEqual([]);
  });

  it('returns an empty list for empty settings', () => {
    expect(controlPlaneProviderInputs({})).toEqual([]);
  });
});

describe('controlPlaneJobStatus', () => {
  it('maps dead_lettered to blocked', () => {
    expect(controlPlaneJobStatus('dead_lettered')).toBe('blocked');
  });

  it('maps paused to needs_action', () => {
    expect(controlPlaneJobStatus('paused')).toBe('needs_action');
  });

  it('maps running and undefined to ready', () => {
    expect(controlPlaneJobStatus('running')).toBe('ready');
    expect(controlPlaneJobStatus(undefined)).toBe('ready');
  });
});

describe('controlPlaneMemoryStatus', () => {
  it('maps enabled to Ready and disabled to Disabled', () => {
    expect(controlPlaneMemoryStatus(true)).toBe('Ready');
    expect(controlPlaneMemoryStatus(false)).toBe('Disabled');
  });
});
