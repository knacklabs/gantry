import type { StreamingChunkOptions } from '../domain/types.js';

let jobStreamingGenerationCounter = 0;

export function resetJobStreamingGenerationForTests(): void {
  jobStreamingGenerationCounter = 0;
}

export const nextJobStreamingGeneration = (): number =>
  ++jobStreamingGenerationCounter;

export function buildJobStreamingOptions(input: {
  generation: number;
  threadId?: string | null;
  done?: boolean;
}): StreamingChunkOptions {
  const options: StreamingChunkOptions = { generation: input.generation };
  if (input.threadId) options.threadId = input.threadId;
  if (input.done !== undefined) options.done = input.done;
  return options;
}
