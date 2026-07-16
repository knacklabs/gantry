import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';

const workflowDraftSchema = z.object({
  name: z.string().trim().min(3, 'Enter at least 3 characters.').max(100),
  owner: z.string().trim().min(2, 'Choose a workflow owner.').max(100),
  description: z
    .string()
    .trim()
    .min(16, 'Describe the workflow outcome.')
    .max(400),
});

type WorkflowDraft = z.infer<typeof workflowDraftSchema>;
const templates = [
  {
    value: 'blank',
    label: 'Blank workflow',
    detail: 'Start with an empty ordered canvas.',
  },
  {
    value: 'approval',
    label: 'Approval flow',
    detail: 'Agent step, owner approval, then notification.',
  },
  {
    value: 'external',
    label: 'External wait',
    detail: 'Agent step followed by an external system wait.',
  },
] as const;

export function NewWorkflowRoute() {
  const search = useSearch({ from: '/workflows/new' });
  const navigate = useNavigate({ from: '/workflows/new' });
  const { requestConnection } = useConnectionGate();
  const {
    formState: { errors, isDirty },
    handleSubmit,
    register,
  } = useForm<WorkflowDraft>({
    defaultValues: { name: '', owner: '', description: '' },
    resolver: zodResolver(workflowDraftSchema),
  });

  return (
    <div className="mx-auto grid w-full max-w-[900px] gap-6">
      <Link
        className="inline-flex w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{ q: '', status: 'all' }}
        to="/workflows"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Workflows
      </Link>
      <PageHeader
        eyebrow="Automation"
        title="New workflow"
        description="Choose a starting point and create a local draft."
      />
      <Panel
        title="Template"
        description="Templates add preview steps only; no engine is created."
      >
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          {templates.map((template) => (
            <button
              aria-pressed={search.template === template.value}
              className={`grid gap-2 rounded-md border p-4 text-left ${search.template === template.value ? 'border-ink bg-surface-strong' : 'border-border hover:bg-surface-muted'}`}
              key={template.value}
              type="button"
              onClick={() =>
                void navigate({ search: { template: template.value } })
              }
            >
              <strong className="text-[13px] text-text">
                {template.label}
              </strong>
              <span className="text-xs leading-5 text-text-secondary">
                {template.detail}
              </span>
            </button>
          ))}
        </div>
      </Panel>
      <Panel title="Draft details" description="Stored in this page only.">
        <form
          className="grid gap-5 p-5"
          onSubmit={(event) =>
            void handleSubmit(() => requestConnection('Create workflow draft'))(
              event,
            )
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              id="workflow-name"
              label="Workflow name"
              error={errors.name?.message}
              {...register('name')}
            />
            <TextField
              id="workflow-owner"
              label="Owner"
              error={errors.owner?.message}
              {...register('owner')}
            />
          </div>
          <label className="grid gap-1.5" htmlFor="workflow-description">
            <span className="text-xs font-semibold text-text">Outcome</span>
            <textarea
              className={`min-h-28 rounded-md border bg-surface px-3 py-2 text-[13px] leading-5 text-text ${errors.description ? 'border-danger' : 'border-border-strong'}`}
              id="workflow-description"
              {...register('description')}
            />
            {errors.description ? (
              <span className="text-xs text-danger">
                {errors.description.message}
              </span>
            ) : null}
          </label>
          <div className="rounded-md border border-status-attention/40 bg-status-attention-soft p-4 text-xs leading-5 text-status-attention">
            Workflow drafts do not schedule, execute, grant permissions, or send
            notifications in the browser. Server-side validation remains
            authoritative.
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <span className="text-xs text-text-muted">
              {isDirty ? 'Unsaved local draft' : 'No draft details entered'}
            </span>
            <Button type="submit">
              <FilePlus2 size={16} aria-hidden="true" />
              Create draft
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
