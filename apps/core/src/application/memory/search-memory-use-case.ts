import type { MemoryRepository } from '../../domain/ports/repositories.js';
import type { MemorySubject } from '../../domain/memory/memory.js';

export class SearchMemoryUseCase {
  constructor(private readonly memory: MemoryRepository) {}

  async execute(input: { subject: MemorySubject; limit?: number }) {
    return {
      memories: await this.memory.listMemoryItems(input.subject, input.limit),
    };
  }
}
