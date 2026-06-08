import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { SkillCatalogItem, SkillId } from '../../domain/skills/skills.js';
import { canonicalSkillReference } from '../../domain/skills/skill-identity.js';

export interface ResolvedSkillReferences {
  skills: Map<string, SkillCatalogItem>;
  errors: Map<string, string>;
}

export function selectedSkillsFromResolvedSkillReferences(
  references: readonly string[],
  resolved: ResolvedSkillReferences,
): SkillCatalogItem[] {
  const seen = new Set<string>();
  const skills: SkillCatalogItem[] = [];
  for (const reference of references) {
    const skill = resolved.skills.get(reference);
    if (!skill) continue;
    const canonicalReference = canonicalSkillReference(skill);
    if (seen.has(canonicalReference)) continue;
    seen.add(canonicalReference);
    skills.push(skill);
  }
  return skills;
}

export async function resolveConfiguredSkillReferences(input: {
  repository: SkillCatalogRepository;
  appId: AppId;
  agentId: AgentId;
  references: readonly string[];
}): Promise<ResolvedSkillReferences> {
  const uniqueReferences = [...new Set(input.references)];
  const [exactSkills, installedSkills] = await Promise.all([
    loadExactSkillReferences(input.repository, uniqueReferences),
    input.repository.listSkills({
      appId: input.appId,
      statuses: ['installed'],
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

    if (isExactSkillReference(reference)) {
      errors.set(reference, `unavailable skill: ${reference}`);
      continue;
    }

    const skillName = reference;
    const matches = installedSkills.filter(
      (skill) =>
        skill.name === skillName &&
        isUsableSkillForSettings(input.appId, input.agentId, skill),
    );
    if (matches.length === 1) {
      skills.set(reference, matches[0]);
    } else if (matches.length === 0) {
      errors.set(reference, `unavailable skill: ${reference}`);
    } else {
      errors.set(reference, ambiguousSkillNameError(skillName, matches));
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

function isExactSkillReference(reference: string): boolean {
  return reference.startsWith('skill:');
}

function ambiguousSkillNameError(
  skillName: string,
  matches: readonly SkillCatalogItem[],
): string {
  const candidates = matches.map(canonicalSkillReference).sort();
  return `ambiguous skill name: ${skillName} matched ${matches.length} installed skills; use an exact skill id in settings, such as ${candidates.join(', ')}`;
}

function isUsableSkillForSettings(
  appId: AppId,
  agentId: AgentId,
  skill: SkillCatalogItem,
): boolean {
  if (skill.appId !== appId || skill.status !== 'installed') return false;
  return !skill.agentId || skill.agentId === agentId;
}
