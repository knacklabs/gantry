import type { StreamingSink } from '../types.js';

/**
 * Streams report the provider ids already visible, including every part when
 * finished, so replies still match after a partial send or a reset.
 */
export type StreamingChunkResult = Awaited<
  ReturnType<StreamingSink['sendStreamingChunk']>
>;
