import type { AppId } from '../../domain/app/app.js';
import type {
  ChannelInstallation,
  ChannelInstallationId,
  ChannelProviderId,
} from '../../domain/channel/channel.js';
import type { ChannelInstallationRepository } from '../../domain/ports/repositories.js';
import type { Clock } from '../common/clock.js';
import type { IdGenerator } from '../common/id-generator.js';

export interface CreateChannelInstallationInput {
  appId: AppId;
  providerId: ChannelProviderId;
  label: string;
  runtimeSecretRefs?: string[];
}

export class CreateChannelInstallationUseCase {
  constructor(
    private readonly deps: {
      installations: ChannelInstallationRepository;
      ids: IdGenerator;
      clock: Clock;
    },
  ) {}

  async execute(input: CreateChannelInstallationInput) {
    const now = this.deps.clock.now();
    const installation: ChannelInstallation = {
      id: this.deps.ids.generate() as ChannelInstallationId,
      appId: input.appId,
      providerId: input.providerId,
      label: input.label.trim(),
      status: 'active',
      runtimeSecretRefs: input.runtimeSecretRefs ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.installations.saveChannelInstallation(installation);
    return { installation };
  }
}
