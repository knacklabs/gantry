import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  SearchX,
  UserRoundCheck,
} from 'lucide-react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { RouteTabs, type RouteTab } from '../../../ui/compositions/route-tabs';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { InvitePersonForm } from '../components/invite-person-form';
import { MergePersonPreview } from '../components/merge-person-preview';
import type { PersonPreview } from '../people-preview';
import {
  mergeHistoryPreviewQuery,
  peoplePreviewQuery,
} from '../people-queries';

type PersonView = 'profile' | 'invite' | 'merge' | 'history';

const views: RouteTab<PersonView>[] = [
  { value: 'profile', label: 'Profile' },
  { value: 'invite', label: 'Invitation' },
  { value: 'merge', label: 'Merge preview' },
  { value: 'history', label: 'Merge history' },
];

export function PersonDetailRoute() {
  const { personId } = useParams({ from: '/people/$personId' });
  const search = useSearch({ from: '/people/$personId' });
  const navigate = useNavigate({ from: '/people/$personId' });
  const { data: people } = useQuery(peoplePreviewQuery);
  const { data: history } = useQuery(mergeHistoryPreviewQuery);
  const person = people.find((item) => item.id === personId);

  if (!person) {
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} aria-hidden="true" />}
        title="Person not found"
        description="This preview snapshot does not contain that person."
      />
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{
          q: '',
          provider: 'all',
          invitation: 'all',
          page: 1,
          sort: 'name',
          desc: false,
        }}
        to="/people"
      >
        <ArrowLeft size={15} aria-hidden="true" /> People
      </Link>
      <PageHeader
        eyebrow="Canonical person"
        title={person.name}
        description={`${person.title} · ${person.organization}`}
        action={<StatusBadge status={person.invitation} />}
      />
      <Panel title="Person record" description={`Gantry ID: ${person.id}`}>
        <RouteTabs
          label="Person record"
          tabs={views}
          value={search.view}
          onValueChange={(view) => void navigate({ search: { view } })}
        />
        {search.view === 'profile' ? <ProfileView person={person} /> : null}
        {search.view === 'invite' ? <InvitePersonForm person={person} /> : null}
        {search.view === 'merge' ? (
          <MergePersonPreview person={person} people={people} />
        ) : null}
        {search.view === 'history' ? (
          <div className="divide-y divide-border">
            {history.map((entry) => (
              <article
                className="grid gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_auto]"
                key={entry.id}
              >
                <span>
                  <strong className="block text-[13px] text-text">
                    {entry.sourceName} to {entry.targetName}
                  </strong>
                  <span className="mt-1 block text-xs leading-5 text-text-secondary">
                    {entry.result}
                  </span>
                  <span className="mt-2 block font-mono text-[10px] text-text-muted">
                    {entry.actor} · {entry.id}
                  </span>
                </span>
                <span className="text-xs text-text-muted">{entry.time}</span>
              </article>
            ))}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

function ProfileView({ person }: { person: PersonPreview }) {
  return (
    <div className="grid gap-5 p-5">
      <section>
        <h2 className="m-0 text-xs font-semibold text-text">
          Provider aliases and provenance
        </h2>
        <div className="mt-3 grid gap-3">
          {person.aliases.map((alias) => (
            <article
              className="grid gap-3 rounded-md border border-border p-4 sm:grid-cols-[minmax(0,1fr)_auto]"
              key={alias.id}
            >
              <span>
                <strong className="block text-[13px] text-text">
                  {alias.provider} · {alias.display}
                </strong>
                <span className="mt-1 block text-xs text-text-secondary">
                  {alias.providerConnection}
                </span>
                <span className="mt-2 block text-xs leading-5 text-text-muted">
                  {alias.provenance}
                </span>
                <span className="mt-1 block font-mono text-[10px] text-text-muted">
                  provider identity:{alias.providerIdentity}
                </span>
              </span>
              <Badge tone={alias.verified ? 'success' : 'attention'}>
                {alias.verified ? 'Verified' : 'Unverified'}
              </Badge>
            </article>
          ))}
        </div>
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h2 className="m-0 text-xs font-semibold text-text">Conversations</h2>
          <div className="mt-3 grid gap-2">
            {person.conversations.map((conversation) => (
              <div
                className="flex min-h-12 items-center gap-2 rounded-md border border-border px-3 text-[13px] text-text"
                key={conversation}
              >
                <UserRoundCheck size={15} aria-hidden="true" />
                {conversation}
              </div>
            ))}
          </div>
        </section>
        <section>
          <h2 className="m-0 text-xs font-semibold text-text">
            Recent activity
          </h2>
          <div className="mt-3 grid gap-3">
            {person.activity.map((event) => (
              <div
                className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
                key={`${event.time}-${event.summary}`}
              >
                <Clock3 size={15} aria-hidden="true" />
                <span>
                  <strong className="block text-[13px] text-text">
                    {event.summary}
                  </strong>
                  <span className="mt-1 block text-xs text-text-secondary">
                    {event.resource} · {event.time}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
      <div className="flex items-center gap-2 border-t border-border pt-4 text-xs text-text-secondary">
        <CheckCircle2
          className="text-status-success"
          size={15}
          aria-hidden="true"
        />
        Provider aliases remain separate evidence under canonical person:
        {person.id}.
      </div>
    </div>
  );
}
