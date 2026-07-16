import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, Brain, History, ShieldQuestion } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { memoryPreviewQuery } from '../chat-queries';

const categories = [
  'all',
  'Preference',
  'Identity',
  'Project',
  'Relationship',
] as const;
const confidences = ['all', 'high', 'medium', 'low'] as const;

export function MemoryRoute() {
  const search = useSearch({ from: '/memory' });
  const navigate = useNavigate({ from: '/memory' });
  const { data } = useQuery(memoryPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const visible = data.filter(
    (memory) =>
      (search.category === 'all' || memory.category === search.category) &&
      (search.confidence === 'all' || memory.confidence === search.confidence),
  );

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-6">
      <PageHeader
        eyebrow="Continuity"
        title="What I remember"
        description="Owner-visible memory statements with confidence and provenance."
        action={
          <Button
            onClick={() =>
              requestConnection('Review all remembered information')
            }
          >
            <Brain size={16} aria-hidden="true" /> Review memory
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <FilterSelect
          label="Category"
          options={categories}
          value={search.category}
          onChange={(category) =>
            void navigate({ search: { ...search, category } })
          }
        />
        <FilterSelect
          label="Confidence"
          options={confidences}
          value={search.confidence}
          onChange={(confidence) =>
            void navigate({ search: { ...search, confidence } })
          }
        />
      </div>

      <Panel
        title="Remembered information"
        description={`${visible.length} of ${data.length} statements shown`}
        action={<ShieldQuestion size={17} aria-hidden="true" />}
      >
        <div className="divide-y divide-border">
          {visible.map((memory) => (
            <article
              className="grid gap-4 px-5 py-5 md:grid-cols-[minmax(0,1fr)_auto]"
              key={memory.id}
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{memory.category}</Badge>
                  <Badge tone={confidenceTone(memory.confidence)}>
                    {memory.confidence} confidence
                  </Badge>
                </div>
                <p className="mt-3 mb-0 text-sm leading-6 text-text">
                  {memory.statement}
                </p>
                <p className="mt-2 mb-0 inline-flex items-center gap-2 text-xs text-text-muted">
                  <History size={14} aria-hidden="true" /> {memory.provenance} ·
                  Learned {memory.learnedAt}
                </p>
                {memory.contradiction ? (
                  <div className="mt-3 flex gap-2 rounded-md border border-status-attention/40 bg-status-attention-soft p-3 text-xs leading-5 text-status-attention">
                    <AlertTriangle
                      className="mt-0.5 shrink-0"
                      size={15}
                      aria-hidden="true"
                    />
                    <span>{memory.contradiction}</span>
                  </div>
                ) : null}
              </div>
              <Button
                variant="secondary"
                onClick={() =>
                  requestConnection(`Review memory: ${memory.statement}`)
                }
              >
                Review
              </Button>
            </article>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      {label}
      <select
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text capitalize"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option === 'all' ? `All ${label.toLowerCase()}s` : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function confidenceTone(confidence: 'high' | 'medium' | 'low') {
  if (confidence === 'high') return 'success' as const;
  if (confidence === 'medium') return 'attention' as const;
  return 'danger' as const;
}
