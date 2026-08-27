// Transient-permission pause states, extracted from job-readiness-service to
// keep it inside its architecture line budget.
import type { Job } from '../../domain/job-types.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  parseReadableScopedToolRule,
  RUN_COMMAND_TOOL_NAME,
} from '../../shared/agent-tool-references.js';
import {
  approveRuleSetupAction,
  instructionSetupAction,
} from '../../shared/job-setup-action.js';
import {
  buildJobSetupState,
  canonicalSetupToolName,
  requirementTypeForTool,
  toolRequirementLabel,
} from './job-readiness-service.js';

type JobSetupState = NonNullable<Job['setup_state']>;

export function setupStateForTransientPermission(input: {
  toolName: string;
  mode?: string | null;
  recoveryAction?: string | null;
  checkedAt?: string;
  previous?: JobSetupState;
}): JobSetupState {
  const toolName = canonicalSetupToolName(input.toolName);
  return buildJobSetupState({
    checkedAt: input.checkedAt ?? nowIso(),
    previous: input.previous,
    blockers: [
      {
        state: 'missing_capability',
        type: requirementTypeForTool(toolName),
        id: toolName,
        summary: `This scheduled job used temporary ${toolRequirementLabel(toolName)}. Approve lasting access before future runs continue.`,
        // Typed one-tap grant when derivable from the tool identity alone;
        // bare command tools fall to plain language (never protocol text).
        action: transientPermissionSetupAction(toolName),
      },
    ],
  });
}

function transientPermissionSetupAction(toolName: string) {
  const scoped = parseReadableScopedToolRule(toolName);
  return ((scoped?.toolName ?? toolName) === RUN_COMMAND_TOOL_NAME &&
    !scoped?.scope) ||
    toolName === 'Bash'
    ? instructionSetupAction(
        'This job used temporary command access. Approve a scoped command grant from its approval card, then resume the job.',
      )
    : approveRuleSetupAction(toolName);
}
