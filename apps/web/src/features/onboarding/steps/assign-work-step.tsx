import { Check, Hash, ShieldCheck, Users } from 'lucide-react';

import { Button } from '../../../ui/primitives/button';
import type { OnboardingDraft } from '../onboarding-state';
import { Heading } from './create-employee-step';

const workspaces = ['#team-operations', '#customer-support', '#product'];
const approvers = ['You', 'Priya Sharma', 'Lena Kowalski'];

export function AssignWorkStep({
  assigned,
  draft,
  onChange,
  setAssigned,
}: {
  assigned: boolean;
  draft: OnboardingDraft;
  onChange: (update: Partial<OnboardingDraft>) => void;
  setAssigned: (value: boolean) => void;
}) {
  return (
    <div className="grid gap-6">
      <Heading
        body="Choose where preview work arrives and who would approve high-impact actions. These choices stay in this browser only."
        title="Assign work"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <ChoiceCard icon={Hash} title="Workspace channel">
          <div className="grid gap-2">
            {workspaces.map((workspace) => (
              <Choice
                active={draft.workspace === workspace}
                key={workspace}
                onClick={() => {
                  onChange({ workspace });
                  setAssigned(false);
                }}
                text={workspace}
              />
            ))}
          </div>
        </ChoiceCard>
        <ChoiceCard icon={Users} title="Approver">
          <div className="grid gap-2">
            {approvers.map((approver) => (
              <Choice
                active={draft.approver === approver}
                key={approver}
                onClick={() => {
                  onChange({ approver });
                  setAssigned(false);
                }}
                text={approver}
              />
            ))}
          </div>
        </ChoiceCard>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-status-attention/30 bg-status-attention-soft p-5">
        <div className="flex min-w-0 items-start gap-3">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-status-attention"
          />
          <div>
            <h2 className="m-0 text-sm font-semibold">
              Approval stays visible
            </h2>
            <p className="mt-1 mb-0 text-sm leading-6 text-text-secondary">
              The production setup will ask for real permissions before it can
              act. This preview does not grant any access.
            </p>
          </div>
        </div>
        <Button
          onClick={() => setAssigned(true)}
          type="button"
          variant={assigned ? 'outline' : 'default'}
        >
          <Check aria-hidden="true" />
          {assigned ? 'Preview assigned' : 'Mark preview assigned'}
        </Button>
      </div>
    </div>
  );
}

function ChoiceCard({
  children,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  icon: typeof Hash;
  title: string;
}) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-5 shadow-panel">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <Icon aria-hidden="true" className="size-4 text-status-attention" />
        {title}
      </h2>
      {children}
    </section>
  );
}

function Choice({
  active,
  onClick,
  text,
}: {
  active: boolean;
  onClick: () => void;
  text: string;
}) {
  return (
    <button
      className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${active ? 'border-status-attention bg-status-attention-soft' : 'border-border hover:border-border-strong hover:bg-surface-muted'}`}
      onClick={onClick}
      type="button"
    >
      {text}
      {active ? (
        <Check aria-hidden="true" className="size-4 text-status-attention" />
      ) : null}
    </button>
  );
}
