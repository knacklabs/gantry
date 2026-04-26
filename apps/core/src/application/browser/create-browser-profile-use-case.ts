import type { BrowserProfile } from '../../domain/browser/browser.js';
import type { BrowserProfileRepository } from '../../domain/ports/repositories.js';

export class CreateBrowserProfileUseCase {
  constructor(private readonly profiles: BrowserProfileRepository) {}

  async execute(input: { profile: BrowserProfile }) {
    await this.profiles.saveBrowserProfile(input.profile);
    return { profile: input.profile };
  }
}
