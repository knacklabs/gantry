import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { SkillId } from '../../domain/skills/skills.js';
import { ApplicationError } from '../common/application-error.js';

export class ResolveSkillCatalogService {
  constructor(private readonly skills: SkillCatalogRepository) {}

  async resolve(input: { skillId: SkillId }) {
    const skill = await this.skills.getSkill(input.skillId);
    if (!skill) throw new ApplicationError('NOT_FOUND', 'Skill not found');
    return { skill };
  }
}
