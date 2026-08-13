import { createHash } from 'node:crypto';

import { parseReadableScopedToolRule } from './agent-tool-references.js';

interface PermissionAuthorityAdditionShape {
  type: 'addRules' | 'replaceRules';
  behavior: 'allow';
  rules: Array<{ toolName: string; ruleContent?: string }>;
  destination?:
    | 'userSettings'
    | 'projectSettings'
    | 'localSettings'
    | 'session'
    | 'cliArg';
}

export type JobSetupActionShape =
  | { kind: 'approve_grant'; grant: PermissionAuthorityAdditionShape }
  | { kind: 'fix_proposal'; proposalId: string }
  | { kind: 'instruction'; text: string };

interface JobSetupBlockerShape {
  action: JobSetupActionShape;
}

export function jobSetupActionIdentity(action: JobSetupActionShape): string {
  if (action.kind === 'fix_proposal') return action.proposalId;
  if (action.kind === 'instruction') return hash(action.text);
  const subjects = action.grant.rules
    .map((rule) => [rule.toolName, rule.ruleContent ?? ''].join('\u0000'))
    .sort();
  return hash(JSON.stringify(['approve_grant', ...subjects]));
}

export function compareJobSetupBlockers(
  left: JobSetupBlockerShape,
  right: JobSetupBlockerShape,
): number {
  const priority = { approve_grant: 0, fix_proposal: 1, instruction: 2 };
  return (
    priority[left.action.kind] - priority[right.action.kind] ||
    jobSetupActionIdentity(left.action).localeCompare(
      jobSetupActionIdentity(right.action),
    )
  );
}

export function instructionSetupAction(text: string): JobSetupActionShape {
  return { kind: 'instruction', text };
}

export function approveGrantSetupAction(
  grant: PermissionAuthorityAdditionShape,
): JobSetupActionShape {
  return { kind: 'approve_grant', grant };
}

export function approveRuleSetupAction(rule: string): JobSetupActionShape {
  const scoped = parseReadableScopedToolRule(rule);
  return approveGrantSetupAction({
    type: 'addRules',
    behavior: 'allow',
    destination: 'session',
    rules: [
      scoped
        ? { toolName: scoped.toolName, ruleContent: scoped.scope }
        : { toolName: rule },
    ],
  });
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
