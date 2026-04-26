import type { PermissionDecision } from '../../domain/permissions/permissions.js';
import { notImplemented } from '../common/application-error.js';

export class EvaluateToolActionUseCase {
  async execute(input: { action: Record<string, unknown> }): Promise<{
    decision: PermissionDecision;
  }> {
    void input;
    // TODO(next-phase): evaluate tool requests against permission policies before sandbox leasing.
    throw notImplemented('EvaluateToolActionUseCase');
  }
}
