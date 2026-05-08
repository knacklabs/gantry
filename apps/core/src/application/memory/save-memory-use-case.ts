import type { MemoryItem } from '../../domain/memory/memory.js';
import type { MemoryRepository } from '../../domain/ports/repositories.js';

export class SaveMemoryUseCase {
  constructor(private readonly memory: MemoryRepository) {}

  async execute(input: { item: MemoryItem }) {
    void input;
    void this.memory;
    throw new Error(
      'Legacy SaveMemoryUseCase is disabled. Use AppMemoryService.save through app-grade memory boundaries.',
    );
  }
}
