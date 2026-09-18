import { ChevronRight } from 'lucide-react';

import type { OnboardingDraft } from '../onboarding-state';
import { Heading } from './create-employee-step';

const workspaces = ['#team-operations', '#customer-support', '#product'];
const approvers = ['You', 'Priya Sharma', 'Lena Kowalski'];

export function AssignWorkStep({
  draft,
  onChange,
  onContinue,
}: {
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  onContinue: () => void;
}) {
  return (
    <>
      <Heading
        body="Give it one place to start and choose who approves riskier actions."
        title="Put your agent to work"
      />
      <article className="onboarding-card">
        <label className="onboarding-field">
          <span>Give it one place to start</span>
          <select
            onChange={(event) => onChange({ workspace: event.target.value })}
            value={draft.workspace}
          >
            {workspaces.map((workspace) => (
              <option key={workspace}>{workspace}</option>
            ))}
          </select>
        </label>
        <label className="onboarding-field">
          <span>Who approves its riskier actions?</span>
          <select
            onChange={(event) => onChange({ approver: event.target.value })}
            value={draft.approver}
          >
            {approvers.map((approver) => (
              <option key={approver}>{approver}</option>
            ))}
          </select>
        </label>
        <small className="onboarding-help">
          Only members verified in this conversation can approve riskier
          actions.
        </small>
        <button
          className="onboarding-primary justify-self-start"
          onClick={onContinue}
          type="button"
        >
          Continue <ChevronRight aria-hidden="true" size={15} />
        </button>
      </article>
    </>
  );
}
