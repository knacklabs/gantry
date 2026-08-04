import type { AgentAccessSnapshot } from '../application/agent-execution/agent-access-snapshot.js';
import type { Job } from '../domain/types.js';

export function resolveExecutionSkillSelection(input: {
  requiredSkill?: NonNullable<Job['agent_task']>['requiredSkill'];
  snapshot?: AgentAccessSnapshot;
  selected: { ids?: string[]; displays?: string[] };
}): { ids?: string[]; displays?: string[] } {
  const required = input.requiredSkill;
  if (!required) return input.selected;
  const row = input.snapshot?.skills.activeBindings.find(
    (candidate) =>
      candidate.definition?.name === required.name &&
      candidate.definition.storage?.contentHash === required.contentHash,
  );
  if (!row) {
    throw new Error(
      `Required skill ${required.name}@${required.contentHash} is not installed and bound exactly as requested.`,
    );
  }
  return {
    ids: [String(row.binding.skillId)],
    displays: input.selected.displays?.filter((display) =>
      display.includes(required.name),
    ),
  };
}
