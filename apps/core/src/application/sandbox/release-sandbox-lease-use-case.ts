import type { SandboxProvider } from '../../domain/ports/providers.js';
import type { SandboxRepository } from '../../domain/ports/repositories.js';
import type { SandboxLeaseId } from '../../domain/sandbox/sandbox.js';
import { ApplicationError } from '../common/application-error.js';

export class ReleaseSandboxLeaseUseCase {
  constructor(
    private readonly deps: {
      provider: SandboxProvider;
      sandboxes: SandboxRepository;
    },
  ) {}

  async execute(input: { leaseId: SandboxLeaseId }) {
    const lease = await this.deps.sandboxes.getSandboxLease(input.leaseId);
    if (!lease)
      throw new ApplicationError('NOT_FOUND', 'Sandbox lease not found');
    if (lease.status === 'released') return { released: true };
    await this.deps.provider.releaseLease(lease);
    await this.deps.sandboxes.saveSandboxLease({
      ...lease,
      status: 'released',
    });
    return { released: true };
  }
}
