import { Check, MessageCircle } from 'lucide-react';

import { CopyButton } from '../../../ui/primitives/copy-button';
import type { OnboardingDraft } from '../onboarding-state';
import { Heading } from './create-employee-step';

export function SayHelloStep({ draft }: { draft: OnboardingDraft }) {
  const mention = `@${
    draft.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-') || 'your-agent'
  } are you there?`;
  return (
    <div className="grid gap-6">
      <Heading
        body="The full workflow will send a real verification message. For now, review the local preview and open the console when you are ready."
        title="Say hello"
      />
      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-panel">
        <div className="grid gap-px bg-border sm:grid-cols-2">
          <Receipt
            label="Employee"
            value={`${draft.name || 'Untitled employee'} · ${draft.title || 'No title'}`}
          />
          <Receipt label="Model" value={draft.model} />
          <Receipt
            label="Works in"
            value={`${draft.workspace || 'No channel'} · ${draft.channel}`}
          />
          <Receipt label="Approvals" value={draft.approver || 'Not selected'} />
        </div>
      </section>
      <section className="grid gap-4 rounded-2xl border border-border bg-surface-muted p-5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
        <span className="grid size-10 place-items-center rounded-full bg-status-attention-soft text-status-attention">
          <MessageCircle aria-hidden="true" className="size-5" />
        </span>
        <div>
          <h2 className="m-0 text-sm font-semibold">Preview mention</h2>
          <p className="mt-1 mb-0 break-words font-mono text-sm text-text-secondary">
            {mention}
          </p>
        </div>
        <CopyButton label="Copy mention" value={mention} variant="outline" />
      </section>
      <p className="m-0 flex items-center justify-center gap-2 text-center text-sm text-text-secondary">
        <Check aria-hidden="true" className="size-4 text-status-success" />
        Preview complete. No employee, credential, workspace, or message was
        created.
      </p>
    </div>
  );
}

function Receipt({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-surface px-5 py-4">
      <p className="m-0 font-mono text-[10px] font-medium tracking-[0.12em] text-text-muted uppercase">
        {label}
      </p>
      <p className="mt-1 mb-0 truncate text-sm font-medium" title={value}>
        {value}
      </p>
    </div>
  );
}
