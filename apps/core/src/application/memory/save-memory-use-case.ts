import type { MemoryItem } from '../../domain/memory/memory.js';
import type { MemoryRepository } from '../../domain/ports/repositories.js';

export class SaveMemoryUseCase {
  constructor(private readonly memory: MemoryRepository) {}

  async execute(input: { item: MemoryItem }) {
    await this.memory.saveMemoryItem(input.item);
    return { item: input.item };
  }
}
