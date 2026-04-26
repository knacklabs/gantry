import type { AgentRun } from '../../domain/events/events.js';
import type { SandboxProfile } from '../../domain/sandbox/sandbox.js';
import type { SandboxProvider } from '../../domain/ports/providers.js';
import type { SandboxRepository } from '../../domain/ports/repositories.js';

export class CreateSandboxLeaseUseCase {
  constructor(
    private readonly deps: {
      provider: SandboxProvider;
      sandboxes: SandboxRepository;
    },
  ) {}

  async execute(input: { profile: SandboxProfile; run: AgentRun }) {
    const lease = await this.deps.provider.acquireLease(input);
    await this.deps.sandboxes.saveSandboxLease(lease);
    return { lease };
  }
}
