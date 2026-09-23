import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw, SearchX, UserRound } from 'lucide-react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { PageState } from '../../../ui/compositions/page-state';
import { Panel } from '../../../ui/compositions/panel';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Badge } from '../../../ui/primitives/badge';
import { Button } from '../../../ui/primitives/button';
import { peopleDirectoryQuery } from '../people-queries';

export function PersonDetailRoute() {
  const { personId } = useParams({ from: '/people/$personId' });
  const directory = useQuery(peopleDirectoryQuery);
  const person = directory.data?.find((item) => item.id === personId);

  if (directory.isPending)
    return (
      <PageState
        kind="loading"
        icon={<UserRound size={18} />}
        title="Loading person"
        description="Reading the recorded identity."
      />
    );
  if (directory.isError)
    return (
      <PageState
        kind="error"
        icon={<UserRound size={18} />}
        title="Person could not be loaded"
        description="Try loading this person again."
        action={
          <Button onClick={() => void directory.refetch()}>
            <RefreshCw size={15} /> Retry
          </Button>
        }
      />
    );
  if (!person)
    return (
      <PageState
        kind="empty"
        icon={<SearchX size={18} />}
        title="Person not found"
        description="This identity is not in your current People directory."
      />
    );

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <Link
        className="inline-flex min-h-8 w-fit items-center gap-2 text-xs font-semibold text-text-secondary no-underline hover:text-text"
        search={{
          q: '',
          provider: 'all',
          status: 'all',
          page: 1,
          sort: 'displayName',
          desc: false,
        }}
        to="/people"
      >
        <ArrowLeft size={15} aria-hidden="true" /> People
      </Link>
      <PageHeader
        eyebrow="Recorded identity"
        title={person.displayName}
        description={`${person.kind === 'service' ? 'Service identity' : 'Human'} · Updated ${new Date(person.updatedAt).toLocaleDateString()}`}
        action={<StatusBadge status={person.status} />}
      />
      <Panel
        title="Provider identities"
        description={`${person.aliases.length} aliases linked to this person`}
      >
        {person.aliases.length ? (
          <div className="grid gap-3 p-5">
            {person.aliases.map((alias) => (
              <article
                className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-4"
                key={alias.id}
              >
                <div className="grid gap-1">
                  <strong className="text-sm text-text">
                    {alias.displayName ?? alias.provider}
                  </strong>
                  <span className="text-xs text-text-secondary">
                    {alias.provider}
                  </span>
                </div>
                <Badge
                  variant={
                    alias.verificationStatus === 'verified'
                      ? 'success'
                      : 'attention'
                  }
                >
                  {alias.verificationStatus}
                </Badge>
              </article>
            ))}
          </div>
        ) : (
          <p className="m-0 p-5 text-sm text-text-secondary">
            No provider identities are linked to this person.
          </p>
        )}
      </Panel>
      <p className="m-0 font-mono text-xs text-text-muted">
        Gantry person ID: {person.id}
      </p>
    </div>
  );
}
