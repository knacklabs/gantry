import { useEffect, useState } from 'react';

import { Button } from '../../../ui/primitives/button';
import {
  useConversationDashboard,
  useDiscoverConversations,
} from '../../operations/use-conversations';
import {
  useCreateSetupProviderAccount,
  useSetupProviders,
} from '../use-setup-providers';

export function SetupConnectionDetails({
  agentId,
  selectedAccountId,
  onSelect,
}: {
  agentId?: string;
  selectedAccountId: string;
  onSelect: (accountId: string) => void;
}) {
  const dashboard = useConversationDashboard();
  const discover = useDiscoverConversations();
  const providers = useSetupProviders();
  const createAccount = useCreateSetupProviderAccount();
  const [providerId, setProviderId] = useState('');
  const [label, setLabel] = useState('');
  const [secretRefs, setSecretRefs] = useState<Record<string, string>>({});
  const selectedProvider = providers.data?.providers.find(
    (provider) => provider.id === providerId,
  );
  const accounts = (dashboard.data?.providerAccounts ?? []).filter(
    (account) => account.agentId === agentId,
  );

  useEffect(() => {
    setSecretRefs(
      Object.fromEntries(
        (selectedProvider?.runtimeSecretKeys ?? []).map((key) => [key, '']),
      ),
    );
  }, [selectedProvider?.id, selectedProvider?.runtimeSecretKeys]);

  if (dashboard.isPending) {
    return (
      <p className="m-0 text-sm text-text-secondary">Loading connections…</p>
    );
  }

  if (!agentId) {
    return (
      <p className="m-0 text-sm text-text-secondary">
        Create the agent before adding a provider connection.
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 rounded-md border border-border bg-surface-muted p-4">
        <p className="m-0 text-sm font-semibold text-text">
          Add a provider connection
        </p>
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Provider
          <select
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
          >
            <option value="">Choose a provider</option>
            {(providers.data?.providers ?? []).map((provider) => (
              <option
                disabled={provider.status !== 'available'}
                key={provider.id}
                value={provider.id}
              >
                {provider.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Connection label
          <input
            className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text placeholder:text-text-muted"
            placeholder="e.g. Primary workspace connection"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        {(selectedProvider?.runtimeSecretKeys ?? []).map((key) => (
          <label
            className="grid gap-1.5 text-xs font-semibold text-text"
            key={key}
          >
            {key} reference
            <input
              className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text placeholder:text-text-muted"
              placeholder="gantry-secret:YOUR_SECRET_NAME"
              value={secretRefs[key] ?? ''}
              onChange={(event) =>
                setSecretRefs((current) => ({
                  ...current,
                  [key]: event.target.value,
                }))
              }
            />
          </label>
        ))}
        <p className="m-0 text-xs leading-5 text-text-muted">
          Enter only stored secret references. Paste credential values through
          the CLI or another approved server-side secret path.
        </p>
        <Button
          disabled={!providerId || !label.trim() || createAccount.isPending}
          onClick={() =>
            createAccount.mutate(
              {
                agentId,
                providerId,
                label: label.trim(),
                runtimeSecretRefs: Object.fromEntries(
                  Object.entries(secretRefs).filter(([, value]) =>
                    value.trim(),
                  ),
                ),
              },
              { onSuccess: (account) => onSelect(account.id) },
            )
          }
        >
          {createAccount.isPending ? 'Adding connection…' : 'Add connection'}
        </Button>
        {createAccount.isError ? (
          <p className="m-0 text-sm text-danger">
            {createAccount.error.message}
          </p>
        ) : null}
      </div>
      <label className="grid gap-1.5 text-xs font-semibold text-text">
        Provider connection
        <select
          className="h-9 rounded-md border border-border-strong bg-surface px-3 text-[13px] font-normal text-text disabled:text-text-muted"
          disabled={accounts.length === 0}
          value={selectedAccountId}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">
            {accounts.length === 0
              ? 'No provider connections are available.'
              : 'Choose a provider connection'}
          </option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!selectedAccountId || discover.isPending}
          onClick={() => discover.mutate(selectedAccountId)}
        >
          {discover.isPending
            ? 'Discovering conversations…'
            : 'Discover conversations'}
        </Button>
        <span className="text-sm text-text-muted">
          Discovery refreshes the conversations available to this connection.
        </span>
      </div>
      {discover.isError ? (
        <p className="m-0 text-sm text-danger">{discover.error.message}</p>
      ) : null}
      {discover.isSuccess ? (
        <p className="m-0 text-sm text-status-ready">
          Conversations discovered. Continue to choose access.
        </p>
      ) : null}
    </div>
  );
}
