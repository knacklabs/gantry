// `model_families` is an optional map of <familyAlias> -> [member-or-provider...]
// in preference order (the reserved `cheapest` token selects cost-ordering).
// Structural validation only: each value must be a non-empty string array.
// Unknown family aliases and unknown members are tolerated here and ignored at
// resolve time (effectiveFamilyMembers), so the override is always a partial
// reorder and never a way to add/drop a member.
export function parseModelFamilies(raw: unknown): Record<string, string[]> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('model_families must be a mapping');
  }
  const families: Record<string, string[]> = {};
  for (const [alias, membersRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    families[alias] = parseModelFamilyMembers(membersRaw, alias);
  }
  return families;
}

function parseModelFamilyMembers(raw: unknown, alias: string): string[] {
  const pathPrefix = `model_families.${alias}`;
  if (!Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a string array`);
  }
  return [
    ...new Set(
      raw.map((item, index) => {
        if (typeof item !== 'string' || item.trim().length === 0) {
          throw new Error(`${pathPrefix}[${index}] must be a non-empty string`);
        }
        return item.trim();
      }),
    ),
  ];
}
