import type { AgentRun } from '../../domain/events/events.js';
import type { SandboxProfile } from '../../domain/sandbox/sandbox.js';
import type { SandboxProvider } from '../../domain/ports/providers.js';
import type { SandboxRepository } from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';
import type {
  EvaluateToolActionInput,
  EvaluateToolActionUseCase,
} from '../tools/evaluate-tool-action-use-case.js';

export class CreateSandboxLeaseUseCase {
  constructor(
    private readonly deps: {
      provider: SandboxProvider;
      sandboxes: SandboxRepository;
      toolEvaluator?: Pick<EvaluateToolActionUseCase, 'execute'>;
    },
  ) {}

  async execute(input: {
    profile: SandboxProfile;
    run: AgentRun;
    action?: EvaluateToolActionInput;
  }) {
    if (input.action) {
      if (!this.deps.toolEvaluator) {
        throw new ApplicationError(
          'FORBIDDEN',
          'Tool action evaluation is required before sandbox leasing',
        );
      }
      const { decision } = await this.deps.toolEvaluator.execute(input.action);
      if (
        decision.effect === 'deny' ||
        decision.effect === 'require_approval'
      ) {
        throw new ApplicationError(
          'FORBIDDEN',
          decision.reason || 'Tool action is not approved for sandbox leasing',
        );
      }
    }
    const lease = await this.deps.provider.acquireLease(input);
    await this.deps.sandboxes.saveSandboxLease(lease);
    return { lease };
  }
}
