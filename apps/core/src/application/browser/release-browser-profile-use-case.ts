import type { BrowserProfileId } from '../../domain/browser/browser.js';
import type { BrowserRuntimeProvider } from '../../domain/ports/providers.js';
import type { BrowserProfileRepository } from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

export class ReleaseBrowserProfileUseCase {
  constructor(
    private readonly deps: {
      profiles: BrowserProfileRepository;
      runtime: BrowserRuntimeProvider;
    },
  ) {}

  async execute(input: { profileId: BrowserProfileId }) {
    const profile = await this.deps.profiles.getBrowserProfile(input.profileId);
    if (!profile)
      throw new ApplicationError('NOT_FOUND', 'Browser profile not found');
    await this.deps.runtime.closeProfile(profile);
    return { released: true };
  }
}
