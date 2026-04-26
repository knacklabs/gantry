import type { WorkspaceSnapshot } from '../../domain/sandbox/sandbox.js';
import type { SandboxRepository } from '../../domain/ports/repositories.js';

export class SnapshotWorkspaceUseCase {
  constructor(private readonly sandboxes: SandboxRepository) {}

  async execute(input: { snapshot: WorkspaceSnapshot }) {
    await this.sandboxes.saveWorkspaceSnapshot(input.snapshot);
    return { snapshot: input.snapshot };
  }
}
