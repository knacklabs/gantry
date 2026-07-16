import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { MessageSquarePlus, Search } from 'lucide-react';
import { type FormEvent } from 'react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { TextField } from '../../../ui/compositions/text-field';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { sessionPreviewQuery } from '../chat-queries';

const statuses = ['all', 'active', 'waiting', 'completed'] as const;
const agents = [
  'all',
  'Support triage',
  'Research assistant',
  'Operations analyst',
] as const;

export function ChatRoute() {
  const search = useSearch({ from: '/chat' });
  const navigate = useNavigate({ from: '/chat' });
  const { data } = useQuery(sessionPreviewQuery);
  const { requestConnection } = useConnectionGate();
  const query = search.q.toLowerCase();
  const visible = data.filter(
    (session) =>
      (search.status === 'all' || session.status === search.status) &&
      (search.agent === 'all' || session.agent === search.agent) &&
      (!query ||
        `${session.title} ${session.agent} ${session.preview}`
          .toLowerCase()
          .includes(query)),
  );

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void navigate({ search: { ...search, q: String(form.get('q') ?? '') } });
  }

  return (
    <div className="mx-auto grid w-full max-w-[1100px] gap-6">
      <PageHeader
        eyebrow="Conversations"
        title="Chat"
        description="Recent sessions and owner-visible interaction state."
        action={
          <Button onClick={() => requestConnection('Create chat session')}>
            <MessageSquarePlus size={16} aria-hidden="true" />
            New chat
          </Button>
        }
      />

      <form
        className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_170px_190px_auto]"
        onSubmit={submitSearch}
      >
        <TextField
          defaultValue={search.q}
          id="chat-search"
          label="Search sessions"
          name="q"
          placeholder="Title, agent, or content"
        />
        <FilterSelect
          label="Status"
          options={statuses}
          value={search.status}
          onChange={(status) =>
            void navigate({ search: { ...search, status } })
          }
        />
        <FilterSelect
          label="Agent"
          options={agents}
          value={search.agent}
          onChange={(agent) => void navigate({ search: { ...search, agent } })}
        />
        <Button variant="secondary" type="submit">
          <Search size={15} aria-hidden="true" />
          Search
        </Button>
      </form>

      <Panel
        title="Sessions"
        description={`${visible.length} matching sessions`}
      >
        <div className="divide-y divide-border">
          {visible.map((session) => (
            <Link
              className="grid gap-3 px-5 py-4 text-text no-underline hover:bg-surface-muted sm:grid-cols-[minmax(0,1fr)_auto]"
              key={session.id}
              params={{ sessionId: session.id }}
              search={{ inspector: 'thread' }}
              to="/chat/$sessionId"
            >
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm">{session.title}</strong>
                  <StatusBadge status={session.status} />
                  {session.unread ? (
                    <Badge tone="attention">{session.unread} new</Badge>
                  ) : null}
                </span>
                <span className="mt-1 block text-xs text-text-secondary">
                  {session.agent} · {session.conversation}
                </span>
                <span className="mt-2 block truncate text-[13px] text-text-secondary">
                  {session.preview}
                </span>
              </span>
              <span className="text-xs text-text-muted">
                {session.activity}
              </span>
            </Link>
          ))}
          {visible.length === 0 ? (
            <p className="m-0 px-5 py-12 text-center text-sm text-text-secondary">
              No sessions match these filters.
            </p>
          ) : null}
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
        className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
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
