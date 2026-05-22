import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { SkillCatalogItem, SkillId } from '../../domain/skills/skills.js';

export interface ResolvedSkillReferences {
  skills: Map<string, SkillCatalogItem>;
  errors: Map<string, string>;
}

export function displaySkillReference(skill: Pick<SkillCatalogItem, 'name'>) {
  return skill.name;
}

export async function resolveConfiguredSkillReferences(input: {
  repository: SkillCatalogRepository;
  appId: AppId;
  agentId: AgentId;
  references: readonly string[];
}): Promise<ResolvedSkillReferences> {
  const uniqueReferences = [...new Set(input.references)];
  const [exactSkills, approvedSkills] = await Promise.all([
    loadExactSkillReferences(input.repository, uniqueReferences),
    input.repository.listSkills({
      appId: input.appId,
      statuses: ['approved'],
    }),
  ]);
  const skills = new Map<string, SkillCatalogItem>();
  const errors = new Map<string, string>();

  for (const reference of uniqueReferences) {
    const exactSkill = exactSkills.get(reference);
    if (exactSkill) {
      if (isUsableSkillForSettings(input.appId, input.agentId, exactSkill)) {
        skills.set(reference, exactSkill);
      } else {
        errors.set(reference, `unavailable skill: ${reference}`);
      }
      continue;
    }

    const skillName = skillNameFromSettingsReference(reference);
    const matches = approvedSkills.filter(
      (skill) =>
        skill.name === skillName &&
        isUsableSkillForSettings(input.appId, input.agentId, skill),
    );
    if (matches.length === 1) {
      skills.set(reference, matches[0]);
    } else if (matches.length === 0) {
      errors.set(reference, `unavailable skill: ${reference}`);
    } else {
      errors.set(
        reference,
        `ambiguous skill name: ${skillName} matched ${matches.length} approved skills`,
      );
    }
  }

  return { skills, errors };
}

async function loadExactSkillReferences(
  repository: SkillCatalogRepository,
  references: readonly string[],
): Promise<Map<string, SkillCatalogItem>> {
  const exactReferences = references.filter((reference) =>
    reference.startsWith('skill:'),
  );
  const rows = await Promise.all(
    exactReferences.map(async (reference) => {
      const skill = await repository.getSkill(reference as SkillId);
      return [reference, skill] as const;
    }),
  );
  return new Map(
    rows.flatMap(([reference, skill]) =>
      skill ? ([[reference, skill]] as const) : [],
    ),
  );
}

function skillNameFromSettingsReference(reference: string): string {
  return reference.startsWith('skill:')
    ? reference.slice('skill:'.length)
    : reference;
}

function isUsableSkillForSettings(
  appId: AppId,
  agentId: AgentId,
  skill: SkillCatalogItem,
): boolean {
  if (skill.appId !== appId || skill.status !== 'approved') return false;
  return !skill.agentId || skill.agentId === agentId;
}
