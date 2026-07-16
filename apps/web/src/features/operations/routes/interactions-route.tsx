import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  ListFilter,
} from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { SegmentedControl } from '../../../ui/primitives/segmented-control';
import { interactionPreviewQuery } from '../operations-queries';

const filterOptions = [
  { value: 'all', label: 'All', icon: ListFilter },
  { value: 'approval', label: 'Approvals', icon: CheckCircle2 },
  { value: 'question', label: 'Questions', icon: CircleHelp },
] as const;

export function InteractionsRoute() {
  const search = useSearch({ from: '/interactions' });
  const navigate = useNavigate({ from: '/interactions' });
  const { data } = useQuery(interactionPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const visible = data.filter(
    (item) => search.kind === 'all' || item.kind === search.kind,
  );
  const selected =
    visible.find((item) => item.id === search.selected) ?? visible[0];

  return (
    <div className="mx-auto grid w-full max-w-[1240px] gap-6">
      <PageHeader
        eyebrow="Operations"
        title="Waiting on you"
        description="Questions and approval requests paused for an owner decision."
        action={<Badge tone="attention">{data.length} pending</Badge>}
      />

      <SegmentedControl
        aria-label="Interaction type"
        options={[...filterOptions]}
        value={search.kind}
        onValueChange={(kind) =>
          void navigate({ search: { kind, selected: undefined } })
        }
      />

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(300px,.8fr)_minmax(0,1.2fr)]">
        <Panel
          title="Pending"
          description={`${visible.length} matching interactions`}
        >
          <div className="divide-y divide-border">
            {visible.map((item) => (
              <button
                aria-pressed={selected?.id === item.id}
                className={`grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 px-4 py-4 text-left hover:bg-surface-muted ${selected?.id === item.id ? 'bg-surface-strong' : 'bg-transparent'}`}
                key={item.id}
                type="button"
                onClick={() =>
                  void navigate({ search: { ...search, selected: item.id } })
                }
              >
                <span
                  className={
                    item.kind === 'approval'
                      ? 'text-status-attention'
                      : 'text-text-secondary'
                  }
                >
                  {item.kind === 'approval' ? (
                    <AlertCircle size={17} aria-hidden="true" />
                  ) : (
                    <CircleHelp size={17} aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-text">
                    {item.title}
                  </span>
                  <span className="mt-1 block text-xs text-text-secondary">
                    {item.agent} · {item.requestedAt}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Panel>

        {selected ? (
          <Panel
            title={selected.title}
            description={`${selected.kind === 'approval' ? 'Permission request' : 'Question'} from ${selected.agent}`}
            action={<RiskBadge risk={selected.risk} />}
          >
            <div className="grid gap-5 p-5">
              <p className="m-0 max-w-2xl text-sm leading-6 text-text-secondary">
                {selected.description}
              </p>
              <dl className="m-0 grid gap-3 border-y border-border py-4 text-[13px] sm:grid-cols-2">
                <Detail label="Conversation" value={selected.conversation} />
                <Detail label="Requested" value={selected.requestedAt} />
                <Detail label="Agent" value={selected.agent} />
                <Detail label="Request ID" value={selected.id} mono />
              </dl>
              <div>
                <p className="mt-0 mb-2 text-xs font-semibold text-text">
                  Decision
                </p>
                <div className="flex flex-wrap gap-2">
                  {selected.choices.map((choice, index) => (
                    <Button
                      key={choice}
                      variant={
                        choice === 'Cancel'
                          ? 'ghost'
                          : index === 0
                            ? 'primary'
                            : 'secondary'
                      }
                      onClick={() =>
                        requestConnection(`${choice}: ${selected.title}`)
                      }
                    >
                      {choice}
                    </Button>
                  ))}
                </div>
                <p className="mt-3 mb-0 text-xs leading-5 text-text-muted">
                  Decisions are disabled in preview mode. This record will
                  remain pending.
                </p>
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="No matching interactions">
            <p className="m-0 p-5 text-sm text-text-secondary">
              Choose another interaction filter.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
}

function Detail({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className={`mt-1 ml-0 text-text ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

function RiskBadge({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  const tone =
    risk === 'high' ? 'danger' : risk === 'medium' ? 'attention' : 'neutral';
  return <Badge tone={tone}>{risk} risk</Badge>;
}
