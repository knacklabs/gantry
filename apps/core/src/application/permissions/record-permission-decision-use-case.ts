import type { PermissionDecision } from '../../domain/permissions/permissions.js';
import type { PermissionRepository } from '../../domain/ports/repositories.js';

export class RecordPermissionDecisionUseCase {
  constructor(private readonly permissions: PermissionRepository) {}

  async execute(input: { decision: PermissionDecision }) {
    await this.permissions.saveDecision(input.decision);
    return { decision: input.decision };
  }
}
