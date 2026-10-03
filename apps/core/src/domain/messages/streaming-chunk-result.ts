import type { StreamingSink } from '../types.js';

/**
 * A finished stream (options.done) reports the provider ids of every message
 * the answer spans, so replies to any part of it can be matched.
 */
export type StreamingChunkResult = Awaited<
  ReturnType<StreamingSink['sendStreamingChunk']>
>;
