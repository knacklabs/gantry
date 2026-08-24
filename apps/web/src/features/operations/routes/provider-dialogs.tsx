import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Settings2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { providerAssetById } from '../../../assets/providers';
import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/primitives/dialog';
import { Input } from '../../../ui/primitives/input';
import { type ModelProvider, modelProviderQuery } from '../operations-queries';

export function ProviderPicker({
  onOpenChange,
  onSelect,
  open,
  providers,
}: {
  onOpenChange: (open: boolean) => void;
  onSelect: (provider: ModelProvider) => void;
  open: boolean;
  providers: ModelProvider[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add model provider</DialogTitle>
          <DialogDescription>
            Choose an unconfigured provider to add credentials.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {providers
            .filter((provider) => !provider.configured)
            .map((provider) => (
              <Button
                key={provider.providerId}
                onClick={() => onSelect(provider)}
                variant="secondary"
              >
                {provider.label}
              </Button>
            ))}
          {!providers.some((provider) => !provider.configured) ? (
            <p className="m-0 text-sm text-text-muted">
              Every supported provider is configured.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ProviderRow({
  canManage,
  provider,
  onManage,
}: {
  canManage: boolean;
  provider: ModelProvider;
  onManage: () => void;
}) {
  const asset = providerAssetById[provider.providerId];
  const status = provider.health === 'missing' ? 'attention' : provider.health;
  return (
    <li className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        {asset ? (
          <img alt="" className="size-9 rounded-md" src={asset} />
        ) : (
          <span
            aria-hidden="true"
            className="inline-grid size-9 shrink-0 place-items-center rounded-md bg-surface-muted font-mono text-xs font-semibold text-text"
          >
            {provider.label.slice(0, 2).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{provider.label}</strong>
            {provider.required ? (
              <span className="text-xs font-medium text-text-muted">
                Required by {provider.requiredBy.join(', ')}
              </span>
            ) : null}
          </div>
          <p className="m-0 text-xs text-text-muted">
            {provider.supportedWorkloads.join(', ') || 'Model provider'}
            {provider.updatedAt
              ? ` · Updated ${new Date(provider.updatedAt).toLocaleDateString()}`
              : ''}
          </p>
        </div>
      </div>
      <StatusBadge status={status} />
      <Button onClick={onManage} size="sm" variant="secondary">
        <Settings2 aria-hidden="true" size={15} />
        {canManage ? 'Manage' : 'View'}
      </Button>
    </li>
  );
}

export function ProviderDialog({
  canManage,
  provider,
  onOpenChange,
}: {
  canManage: boolean;
  provider: ModelProvider | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mode =
    provider?.credentialModes.find((item) => item.id === provider.authMode) ??
    provider?.credentialModes[0];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !mode) return;
    setSaving(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(
      mode.fields.map((field) => [
        field.name,
        String(form.get(field.name) ?? ''),
      ]),
    );
    const response = await browserFetch(
      `/ui/api/model-providers/${encodeURIComponent(provider.providerId)}`,
      {
        method: provider.configured ? 'PATCH' : 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...browserCsrfHeader(),
        },
        body: JSON.stringify({
          ...(provider.configured ? {} : { authMode: mode.id }),
          payload,
        }),
      },
    );
    setSaving(false);
    if (!response.ok) {
      setError('Credential changes could not be saved.');
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: modelProviderQuery.queryKey,
    });
    onOpenChange(false);
  }

  async function verify() {
    if (!provider) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const response = await browserFetch(
      `/ui/api/model-providers/${encodeURIComponent(provider.providerId)}/verify`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: browserCsrfHeader(),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    setSaving(false);
    if (!response.ok) {
      setError('Credential verification could not be completed.');
      return;
    }
    setNotice(body?.message ?? 'Credential verification finished.');
  }

  async function disable() {
    if (!provider || !window.confirm(`Disable ${provider.label}?`)) return;
    setSaving(true);
    setError(null);
    const response = await browserFetch(
      `/ui/api/model-providers/${encodeURIComponent(provider.providerId)}`,
      {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: browserCsrfHeader(),
      },
    );
    setSaving(false);
    if (!response.ok) {
      setError('Credential could not be disabled.');
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: modelProviderQuery.queryKey,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={Boolean(provider)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {provider?.configured
              ? `Manage ${provider.label}`
              : `Add ${provider?.label ?? 'provider'}`}
          </DialogTitle>
          <DialogDescription>
            Credential values are write-only and are never shown again.
          </DialogDescription>
        </DialogHeader>
        {provider && mode && canManage ? (
          <form className="grid gap-4" onSubmit={submit}>
            {mode.fields.map((field) => (
              <label
                className="grid gap-1.5 text-sm font-medium"
                key={field.name}
              >
                {field.label}
                <Input
                  name={field.name}
                  required={field.required}
                  type={field.secret ? 'password' : 'text'}
                />
              </label>
            ))}
            {error ? <p className="m-0 text-sm text-danger">{error}</p> : null}
            {notice ? (
              <p className="m-0 text-sm text-text-secondary">{notice}</p>
            ) : null}
            <DialogFooter>
              {provider.configured ? (
                <Button
                  disabled={saving}
                  onClick={() => void verify()}
                  type="button"
                  variant="secondary"
                >
                  Verify credential
                </Button>
              ) : null}
              {provider.configured ? (
                <Button
                  disabled={saving}
                  onClick={() => void disable()}
                  type="button"
                  variant="destructive"
                >
                  Disable
                </Button>
              ) : null}
              <Button disabled={saving} type="submit">
                <KeyRound aria-hidden="true" size={16} />
                {saving
                  ? 'Saving…'
                  : provider.configured
                    ? 'Rotate credential'
                    : 'Save credential'}
              </Button>
            </DialogFooter>
          </form>
        ) : provider ? (
          <p className="m-0 text-sm text-text-muted">
            {provider.requiredBy.length > 0
              ? `Required by ${provider.requiredBy.join(', ')}.`
              : 'This provider is optional for the current runtime configuration.'}
          </p>
        ) : (
          <p className="m-0 text-sm text-text-muted">
            This provider has no supported credential mode.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
