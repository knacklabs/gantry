import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  FileText,
  RotateCcw,
  SearchX,
  XCircle,
} from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { ResultReceipt } from '../../../ui/compositions/result-receipt';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import {
  workflowPreviewQuery,
  workflowRunPreviewQuery,
} from '../workflows-queries';

export function WorkflowRunRoute() {
  const { workflowId, runId } = useParams({
    from: '/workflows/$workflowId/runs/$runId',
  });
  const { data: workflows } = useQuery(workflowPreviewQuery);
  const { data: runs } = useQuery(workflowRunPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const workflow = workflows.find((item) => item.id === workflowId);
  const run = runs.find(
    (item) => item.id === runId && item.workflowId === workflowId,
  );

  if (!workflow || !run) {
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} aria-hidden="true" />}
        title="Workflow run not found"
        description="This preview snapshot does not contain that workflow run."
      />
    );
  }

  const waitingStep = run.steps.find((step) => step.status === 'waiting');

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        params={{ workflowId }}
        search={{ view: 'builder' }}
        to="/workflows/$workflowId/edit"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        {workflow.name}
      </Link>
      <PageHeader
        eyebrow={`Workflow run · Version ${run.version}`}
        title={run.id}
        description={`${run.startedAt} · ${run.duration}`}
        action={<StatusBadge status={run.status} />}
      />
      {waitingStep ? (
        <div className="flex flex-col gap-3 rounded-md border border-status-attention/40 bg-status-attention-soft p-4 sm:flex-row sm:items-center sm:justify-between">
          <span>
            <strong className="block text-[13px] text-status-attention">
              Waiting on external step
            </strong>
            <span className="mt-1 block text-xs text-status-attention">
              {waitingStep.name}: {waitingStep.detail}
            </span>
          </span>
          <Button
            variant="secondary"
            onClick={() =>
              requestConnection(`Review external step ${waitingStep.name}`)
            }
          >
            Review external step
          </Button>
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title="Step timeline"
          description={`${run.steps.length} ordered steps`}
        >
          <div className="divide-y divide-border">
            {run.steps.map((step, index) => (
              <article
                className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-3 p-5"
                key={step.id}
              >
                <span className="flex size-8 items-center justify-center rounded-md bg-surface-strong font-mono text-xs text-text">
                  {index + 1}
                </span>
                <span>
                  <strong className="block text-[13px] text-text">
                    {step.name}
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-text-secondary">
                    {step.detail}
                  </span>
                  <span className="mt-2 block font-mono text-[10px] text-text-muted">
                    {step.time}
                  </span>
                </span>
                <StatusBadge status={step.status} />
              </article>
            ))}
          </div>
        </Panel>
        <div className="grid content-start gap-4">
          <Panel
            title="Outcome"
            action={
              run.status === 'completed' ? (
                <CheckCircle2
                  className="text-status-success"
                  size={17}
                  aria-hidden="true"
                />
              ) : (
                <Clock3 size={17} aria-hidden="true" />
              )
            }
          >
            <p className="m-0 p-4 text-sm leading-6 text-text-secondary">
              {run.outcome}
            </p>
          </Panel>
          {run.files.length ? (
            <Panel title="Files">
              {run.files.map((file) => (
                <button
                  className="flex min-h-12 w-full items-center justify-between border-b border-border px-4 text-left last:border-0"
                  key={file.name}
                  type="button"
                  onClick={() => requestConnection(`Download ${file.name}`)}
                >
                  <span className="inline-flex items-center gap-2 text-[13px] text-text">
                    <FileText size={15} aria-hidden="true" />
                    {file.name}
                  </span>
                  <Badge>{file.size}</Badge>
                </button>
              ))}
            </Panel>
          ) : null}
          <Panel title="Result receipt">
            <div className="p-4">
              <ResultReceipt
                attention={run.receipt.attention}
                changed={run.receipt.changed}
                completed={run.outcome}
                delegated={run.receipt.delegated}
                used={run.receipt.used}
              />
            </div>
          </Panel>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button
          variant="secondary"
          onClick={() => requestConnection(`Retry ${run.id}`)}
        >
          <RotateCcw size={15} aria-hidden="true" />
          Retry run
        </Button>
        <Button
          variant="danger"
          onClick={() => requestConnection(`Cancel ${run.id}`)}
        >
          <XCircle size={15} aria-hidden="true" />
          Cancel run
        </Button>
      </div>
    </div>
  );
}
