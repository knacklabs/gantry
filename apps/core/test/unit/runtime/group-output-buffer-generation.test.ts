import { describe, expect, it, vi } from 'vitest';

import { createGroupOutputBuffer } from '@core/runtime/group-output-buffer.js';

function makeBuffer(
  persist: (text: string, status: 'sent' | 'partially_sent') => Promise<void>,
) {
  let deliveryStatus: 'none' | 'sent' | 'partially_sent' = 'none';
  const buffer = createGroupOutputBuffer({
    channelRuntime: {
      sendStreamingChunk: vi.fn(async () => {}),
    } as never,
    chatJid: 'sl:C1',
    groupName: 'group',
    supportsStreamingChunks: true,
    buildStreamingOptions: () => ({}) as never,
    buildMessageOptions: () => undefined,
    sendMessageToChannel: async () => {},
    applyDeliverySettlement: () => {
      deliveryStatus = 'sent';
    },
    resetStreamedTranscriptDeliveryStatus: () => {
      deliveryStatus = 'none';
    },
    getStreamedTranscriptDeliveryStatus: () => deliveryStatus,
    persistCompletedStreamedGeneration: persist,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  });
  return { buffer, status: () => deliveryStatus };
}

describe('streamed generation persistence', () => {
  it('persists the WHOLE generation, not just its final flush', async () => {
    // The visible accumulator resets on every flush, so the `text` a flush sees
    // is only the delta since the previous one. Persisting that alone stores a
    // multi-chunk reply truncated to its last chunk.
    const persisted: string[] = [];
    const { buffer } = makeBuffer(async (text) => {
      persisted.push(text);
    });

    await buffer.appendRawOutput('first chunk. ');
    await buffer.flushBufferedOutput('mid', { done: false, terminal: false });
    await buffer.appendRawOutput('second chunk.');
    await buffer.flushBufferedOutput('end', { done: true, terminal: true });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain('first chunk.');
    expect(persisted[0]).toContain('second chunk.');
  });

  it('does not carry one generation delivery status into the next', async () => {
    const { buffer, status } = makeBuffer(async () => {});
    await buffer.appendRawOutput('delivered generation');
    await buffer.flushBufferedOutput('end', { done: true, terminal: true });
    // After a generation completes its accounting starts clean, so a later
    // wholly undelivered generation cannot inherit 'sent'.
    expect(status()).toBe('none');
  });
});
