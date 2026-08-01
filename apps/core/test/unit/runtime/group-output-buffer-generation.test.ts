import { describe, expect, it, vi } from 'vitest';

import { createGroupOutputBuffer } from '@core/runtime/group-output-buffer.js';

function makeBuffer(
  persist: (text: string, status: 'sent' | 'partially_sent') => Promise<void>,
  options: { deliver?: boolean; undelivered?: string[] } = {},
) {
  const deliver = options.deliver ?? true;
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
      if (deliver) deliveryStatus = 'sent';
    },
    onGenerationUndelivered: (text: string) => {
      options.undelivered?.push(text);
    },
    resetStreamedTranscriptDeliveryStatus: () => {
      deliveryStatus = 'none';
    },
    getStreamedTranscriptDeliveryStatus: () => deliveryStatus,
    persistCompletedStreamedGeneration: persist,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as never,
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

    // Split mid-word on purpose: a flush boundary is a transport detail, so
    // the stored text must be exactly what the user saw, with no separator
    // introduced at the seam.
    await buffer.appendRawOutput('hel');
    await buffer.flushBufferedOutput('mid', { done: false, terminal: false });
    await buffer.appendRawOutput('lo world');
    await buffer.flushBufferedOutput('end', { done: true, terminal: true });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe('hello world');
  });

  it('persists a long generation whole, past the 4k summary bound', async () => {
    // The run-level transcript uses the bounded summary accumulator, which keeps
    // only a 4k tail. Durable message content must not go through it: the user
    // received the whole reply, so /messages must hold the whole reply.
    const persisted: string[] = [];
    const { buffer } = makeBuffer(async (text) => {
      persisted.push(text);
    });
    const head = 'A'.repeat(3000);
    const tail = 'B'.repeat(3000);
    await buffer.appendRawOutput(head);
    await buffer.flushBufferedOutput('mid', { done: false, terminal: false });
    await buffer.appendRawOutput(tail);
    await buffer.flushBufferedOutput('end', { done: true, terminal: true });

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toHaveLength(6000);
    expect(persisted[0].startsWith('A')).toBe(true);
    expect(persisted[0].endsWith('B')).toBe(true);
  });

  it('reports a generation that reached nobody so the fallback can cover it', async () => {
    // outputSentToUser is run-wide: an earlier delivered generation would make
    // finalization return early and drop this one silently.
    const undelivered: string[] = [];
    const { buffer } = makeBuffer(async () => {}, {
      deliver: false,
      undelivered,
    });
    await buffer.appendRawOutput('answer nobody received');
    await buffer.flushBufferedOutput('end', { done: true, terminal: true });
    expect(undelivered).toEqual(['answer nobody received']);
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
