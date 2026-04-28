import type { HostedSkillPublisher } from '../../../../application/skills/skill-draft-service.js';
import type { SkillArtifactStore } from '../../../../domain/ports/skill-artifact-store.js';
import type { SkillProviderRef } from '../../../../domain/skills/skills.js';
import { AnthropicManagedSkillsAdapter } from './anthropic-managed-skills-adapter.js';

export class AnthropicHostedSkillPublisher implements HostedSkillPublisher {
  constructor(
    private readonly adapter: AnthropicManagedSkillsAdapter,
    private readonly artifacts: SkillArtifactStore,
  ) {}

  async publishSkill(input: {
    skill: { name: string; description?: string };
    bundleStorageRef: string;
  }): Promise<SkillProviderRef> {
    const bundle = await this.artifacts.getSkillArtifact(
      input.bundleStorageRef,
    );
    const skill = await this.adapter.createCustomSkillFromAssets({
      displayTitle: input.skill.name,
      assets: bundle.assets,
    });
    return {
      provider: 'anthropic',
      skillId: skill.id,
      type: 'custom',
      version: skill.latestVersion ?? undefined,
    };
  }

  async unpublishSkill(ref: SkillProviderRef): Promise<void> {
    if (ref.provider !== 'anthropic' || ref.type !== 'custom') return;
    await this.adapter.deleteSkill(ref.skillId);
  }
}
