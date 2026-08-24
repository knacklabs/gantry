import { useQuery } from '@tanstack/react-query';
import { rootRoute } from '../../../app/root-route';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { PageHeader } from '../../../ui/compositions/page-header';
import { Panel } from '../../../ui/compositions/panel';
import { SelectField } from '../../../ui/compositions/select-field';
import { TextField } from '../../../ui/compositions/text-field';
import { Button } from '../../../ui/primitives/button';
import { ProviderDialog, ProviderRow } from './provider-dialogs';
import { type ModelProvider, modelProviderQuery } from '../operations-queries';

export function ProvidersRoute() {
  const search = useSearch({ from: '/providers' });
  const { session } = rootRoute.useRouteContext();
  const canManage = session?.principal.role === 'administrator';
  const navigate = useNavigate({ from: '/providers' });
  const query = useQuery(modelProviderQuery);
  const [editing, setEditing] = useState<ModelProvider | null>(null);
  const providers = query.data ?? [];
  const visible = useMemo(
    () =>
      providers.filter((provider) => {
        const status =
          provider.health === 'missing' ? 'attention' : provider.health;
        return (
          (search.status === 'all' || search.status === status) &&
          (!search.q ||
            `${provider.label} ${provider.providerId} ${provider.supportedWorkloads.join(' ')}`
              .toLowerCase()
              .includes(search.q.toLowerCase()))
        );
      }),
    [providers, search.q, search.status],
  );

  return (
    <div className="mx-auto grid w-full max-w-[1120px] gap-6">
      <PageHeader
        eyebrow="Configure"
        title="Model providers"
        description="Credentials and readiness for the models Gantry can use."
      />

      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_190px]">
        <div>
          <TextField
            id="provider-search"
            label="Search providers"
            name="q"
            onChange={(event) =>
              void navigate({
                replace: true,
                search: { ...search, page: 1, q: event.target.value },
              })
            }
            placeholder="Provider or workload"
            value={search.q}
          />
        </div>
        <SelectField
          label="Status"
          value={search.status}
          options={[
            { label: 'All statuses', value: 'all' },
            { label: 'Configured', value: 'ready' },
            { label: 'Not configured', value: 'attention' },
            { label: 'Disabled', value: 'disabled' },
          ]}
          onValueChange={(status) =>
            void navigate({ search: { ...search, status, page: 1 } })
          }
        />
      </div>

      <Panel>
        {query.isLoading ? (
          <p className="p-4 text-sm text-text-muted">Loading providers…</p>
        ) : null}
        {query.isError ? (
          <p className="p-4 text-sm text-danger">
            Model providers could not be loaded.
          </p>
        ) : null}
        {!query.isLoading && !query.isError ? (
          <ul className="m-0 grid list-none divide-y divide-border p-0">
            {visible.map((provider) => (
              <ProviderRow
                key={provider.providerId}
                provider={provider}
                canManage={canManage}
                onManage={() => setEditing(provider)}
              />
            ))}
            {visible.length === 0 ? (
              <li className="p-4 text-sm text-text-muted">
                No model providers match these filters.
              </li>
            ) : null}
          </ul>
        ) : null}
      </Panel>

      <ProviderDialog
        provider={editing}
        onOpenChange={(open) => !open && setEditing(null)}
      />
    </div>
  );
}
