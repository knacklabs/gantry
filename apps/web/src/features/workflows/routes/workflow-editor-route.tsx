import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ArrowLeft, CheckCircle2, Play, SearchX, Upload } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs, type RouteTab } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { WorkflowBuilder } from '../components/workflow-builder';
import { workflowPreviewQuery } from '../workflows-queries';
import type { WorkflowPreview } from '../workflows-preview';

type EditorView = 'builder' | 'review' | 'versions';
const views: RouteTab<EditorView>[] = [
  { value: 'builder', label: 'Builder' },
  { value: 'review', label: 'Draft review' },
  { value: 'versions', label: 'Versions' },
];

export function WorkflowEditorRoute() {
  const { workflowId } = useParams({ from: '/workflows/$workflowId/edit' });
  const search = useSearch({ from: '/workflows/$workflowId/edit' });
  const navigate = useNavigate({ from: '/workflows/$workflowId/edit' });
  const { data } = useQuery(workflowPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const workflow = data.find((item) => item.id === workflowId);

  if (!workflow) {
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} aria-hidden="true" />}
        title="Workflow not found"
        description="This preview snapshot does not contain that workflow."
      />
    );
  }

  const version = workflow.versions[0]!;

  return (
    <div className="mx-auto grid w-full max-w-[1360px] gap-6">
      <Link
        className="inline-flex w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{ q: '', status: 'all' }}
        to="/workflows"
      >
        <ArrowLeft size={15} aria-hidden="true" />
        Workflows
      </Link>
      <PageHeader
        eyebrow="Workflow editor"
        title={workflow.name}
        description={`${workflow.description} · Draft based on v${version.version}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={workflow.status} />
            <Button
              variant="secondary"
              onClick={() =>
                requestConnection(
                  `${workflow.status === 'enabled' ? 'Disable' : 'Enable'} ${workflow.name}`,
                )
              }
            >
              {workflow.status === 'enabled' ? 'Disable' : 'Enable'}
            </Button>
            <Button onClick={() => requestConnection(`Run ${workflow.name}`)}>
              <Play size={15} aria-hidden="true" />
              Run
            </Button>
          </div>
        }
      />
      <Panel
        title="Workflow draft"
        description="Local preview state; published versions are immutable."
      >
        <RouteTabs
          label="Workflow editor"
          tabs={views}
          value={search.view}
          onValueChange={(view) => void navigate({ search: { view } })}
        />
        {search.view === 'builder' ? (
          <WorkflowBuilder initialSteps={version.steps} />
        ) : null}
        {search.view === 'review' ? (
          <DraftReview
            workflow={workflow}
            onPublish={() => requestConnection(`Publish ${workflow.name}`)}
          />
        ) : null}
        {search.view === 'versions' ? (
          <VersionHistory versions={workflow.versions} />
        ) : null}
      </Panel>
    </div>
  );
}

function DraftReview({
  workflow,
  onPublish,
}: {
  workflow: WorkflowPreview;
  onPublish: () => void;
}) {
  const version = workflow.versions[0]!;
  const capabilities = version.steps.flatMap((step) =>
    step.capability ? [step.capability] : [],
  );
  const routes = version.steps.flatMap((step) =>
    step.notificationRoute ? [step.notificationRoute] : [],
  );
  return (
    <div className="grid gap-5 p-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Summary label="Steps" value={String(version.steps.length)} />
        <Summary label="Capabilities" value={String(capabilities.length)} />
        <Summary label="Routes" value={String(routes.length)} />
      </div>
      <section className="grid gap-3">
        <h2 className="m-0 text-xs font-semibold text-text">
          Changes in draft
        </h2>
        <div className="rounded-md border border-border p-4 text-sm leading-6 text-text-secondary">
          {version.summary}
        </div>
      </section>
      <section className="grid gap-3">
        <h2 className="m-0 text-xs font-semibold text-text">
          Required capabilities
        </h2>
        <div className="flex flex-wrap gap-2">
          {capabilities.length ? (
            capabilities.map((capability) => (
              <Badge key={capability}>{capability}</Badge>
            ))
          ) : (
            <span className="text-xs text-text-muted">
              No explicit capabilities.
            </span>
          )}
        </div>
      </section>
      <section className="grid gap-3">
        <h2 className="m-0 text-xs font-semibold text-text">
          Notification routes
        </h2>
        <div className="flex flex-wrap gap-2">
          {routes.length ? (
            routes.map((route) => <Badge key={route}>{route}</Badge>)
          ) : (
            <span className="text-xs text-text-muted">
              No notification routes.
            </span>
          )}
        </div>
      </section>
      <div className="flex gap-3 rounded-md border border-status-success/40 bg-status-success-soft p-4 text-xs leading-5 text-status-success">
        <CheckCircle2 className="shrink-0" size={16} aria-hidden="true" />
        The represented version passes local structural validation. Server-side
        capability, permission, and route validation remains authoritative.
      </div>
      <div className="border-t border-border pt-4">
        <Button onClick={onPublish}>
          <Upload size={16} aria-hidden="true" />
          Publish new version
        </Button>
      </div>
    </div>
  );
}

function VersionHistory({
  versions,
}: {
  versions: WorkflowPreview['versions'];
}) {
  return (
    <div className="divide-y divide-border">
      {versions.map((version) => (
        <article
          className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_auto]"
          key={version.version}
        >
          <span>
            <strong className="block text-[13px] text-text">
              Version {version.version}
            </strong>
            <span className="mt-1 block text-xs leading-5 text-text-secondary">
              {version.summary}
            </span>
            <span className="mt-2 block font-mono text-[10px] text-text-muted">
              {version.createdBy} · {version.steps.length} immutable steps
            </span>
          </span>
          <span className="text-xs text-text-muted">{version.createdAt}</span>
        </article>
      ))}
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-muted p-4">
      <strong className="block text-2xl text-text">{value}</strong>
      <span className="mt-1 block text-xs text-text-secondary">{label}</span>
    </div>
  );
}
