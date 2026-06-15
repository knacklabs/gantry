import { describe, it, expect } from 'vitest';
import {
  IPC_TRANSPORT,
  ipcSocketPathFor,
  IPC_FRAME_MAX_BYTES,
  IPC_HEARTBEAT_INTERVAL_MS,
  IPC_RECONCILE_INTERVAL_MS,
} from '@core/config/index.js';
describe('ipc transport config', () => {
  it('defaults to fs', () => expect(IPC_TRANSPORT).toBe('fs'));
  it('frame max defaults to 1 MiB', () =>
    expect(IPC_FRAME_MAX_BYTES).toBe(1024 * 1024));
  it('heartbeat + reconcile have sane defaults', () => {
    expect(IPC_HEARTBEAT_INTERVAL_MS).toBe(10000);
    expect(IPC_RECONCILE_INTERVAL_MS).toBe(5000);
  });
  it('derives a socket path under the ipc dir', () =>
    expect(ipcSocketPathFor('/data/ipc')).toBe('/data/ipc/core.sock'));
});
