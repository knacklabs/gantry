import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasVerifiedHostedCapabilityWait,
  registerVerifiedHostedCapabilityWait,
} from '@core/runtime/hosted-capability-wait.js';

const scope = {
  appId: 'app',
  agentId: 'agent',
  jobId: 'job',
  runId: 'run',
  runLeaseToken: 'test-lease',
  runLeaseFencingVersion: 2,
};
const disposers: Array<() => void> = [];
function register(
  verifyAuthority: () => Promise<void> = async () => {},
  deadlineAtMs = Date.now() + 60000,
) {
  const dispose = registerVerifiedHostedCapabilityWait({
    ...scope,
    taskId: 'task',
    deadlineAtMs,
    verifyAuthority,
  });
  disposers.push(dispose);
  return dispose;
}
describe('verified hosted execution waiting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.useRealTimers();
  });
  it('does not trust unregistered or incomplete scope', async () => {
    expect(await hasVerifiedHostedCapabilityWait(scope)).toBe(false);
    register();
    expect(await hasVerifiedHostedCapabilityWait({ runId: 'run' })).toBe(false);
  });
  it('requires exact app, agent, job, run and parent fence', async () => {
    const verify = vi.fn(async () => {});
    register(verify);
    for (const changed of [
      { appId: 'other' },
      { agentId: 'other' },
      { jobId: 'other' },
      { runId: 'other' },
      { runLeaseToken: 'other' },
      { runLeaseFencingVersion: 3 },
    ]) {
      expect(
        await hasVerifiedHostedCapabilityWait({ ...scope, ...changed }),
      ).toBe(false);
    }
    expect(verify).not.toHaveBeenCalled();
    expect(await hasVerifiedHostedCapabilityWait(scope)).toBe(true);
    expect(verify).toHaveBeenCalledOnce();
  });
  it('rejects expired execution without querying authority', async () => {
    const verify = vi.fn(async () => {});
    register(verify, Date.now());
    expect(await hasVerifiedHostedCapabilityWait(scope)).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
  it('fails closed when durable cancellation or lease checks reject', async () => {
    register(async () => {
      throw Error('cancelled or changed fence');
    });
    expect(await hasVerifiedHostedCapabilityWait(scope)).toBe(false);
  });
  it('does not retain completed executions', async () => {
    const dispose = register();
    dispose();
    expect(await hasVerifiedHostedCapabilityWait(scope)).toBe(false);
  });
  it('bounds hanging authority checks to three seconds', async () => {
    register(() => new Promise(() => {}));
    const result = hasVerifiedHostedCapabilityWait(scope);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rechecks execution membership after an asynchronous authority result', async () => {
    let resolve!: () => void;
    const dispose = register(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const result = hasVerifiedHostedCapabilityWait(scope);
    dispose();
    resolve();
    expect(await result).toBe(false);
  });
});
