import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { providerAssetById } from '../../../assets/providers';
import {
  browserCsrfHeader,
  browserFetch,
} from '../../../lib/auth/browser-auth';
import { Badge, type BadgeVariant } from '../../../ui/primitives/badge';
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../../ui/primitives/tooltip';
import { type ModelProvider, modelProviderQuery } from '../operations-queries';

type ProviderStatus = {
  description: string;
  label: string;
  variant: BadgeVariant;
};

function providerStatus(provider: ModelProvider): ProviderStatus {
  if (provider.health === 'ready') {
    return {
      label: 'Configured',
      variant: 'success',
      description:
        'An active credential is stored. Verify it to check upstream access.',
    };
  }
  if (provider.health === 'disabled') {
    return {
      label: 'Disabled',
      variant: 'neutral',
      description: provider.required
        ? 'A credential is disabled, but current configuration requires this provider.'
        : 'A credential is stored but disabled, so Gantry will not use this provider.',
    };
  }
  if (provider.required) {
    return {
      label: 'Required',
      variant: 'attention',
      description:
        'No active credential is stored, but current configuration requires this provider.',
    };
  }
  return {
    label: 'Not configured',
    variant: 'neutral',
    description: 'No credential is stored. Add one before using this provider.',
  };
}

function requirementSummary(provider: ModelProvider) {
  const [firstReason, ...otherReasons] = provider.requiredBy;
  if (!firstReason) return null;
  return `Required for ${firstReason}${otherReasons.length ? ` +${otherReasons.length}` : ''}`;
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
  const status = providerStatus(provider);
  const requirement = requirementSummary(provider);
  const actionLabel =
    provider.health === 'ready'
      ? 'Manage credential'
      : provider.health === 'disabled'
        ? 'Re-enable'
        : 'Add credential';
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
            {requirement ? (
              <span className="text-xs font-medium text-text-muted">
                {requirement}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" tabIndex={0}>
            <Badge variant={status.variant}>{status.label}</Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {status.description}
        </TooltipContent>
      </Tooltip>
      {canManage ? (
        <Button onClick={onManage} size="sm" variant="secondary">
          {actionLabel}
        </Button>
      ) : null}
    </li>
  );
}

export function ProviderDialog({
  provider,
  onOpenChange,
}: {
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
  const isDisabled = provider?.health === 'disabled';

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
    if (
      !provider ||
      !window.confirm(
        `Disable ${provider.label}? Gantry will not use it${provider.requiredBy.length ? `, even though it is required for ${provider.requiredBy.join(', ')}` : ''}.`,
      )
    )
      return;
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
            {provider?.health === 'ready'
              ? `Manage ${provider.label} credential`
              : isDisabled
                ? `Re-enable ${provider.label}`
                : `Add ${provider?.label ?? 'provider'} credential`}
          </DialogTitle>
          <DialogDescription>
            {isDisabled
              ? 'Saving a new credential re-enables this provider.'
              : 'Credential values are write-only and are never shown again.'}
          </DialogDescription>
        </DialogHeader>
        {provider && mode ? (
          <form className="grid gap-4" onSubmit={submit}>
            {provider.requiredBy.length > 0 ? (
              <p className="m-0 text-sm text-text-muted">
                Required for {provider.requiredBy.join(', ')}.
              </p>
            ) : null}
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
            {error ? (
              <p aria-live="polite" className="m-0 text-sm text-danger">
                {error} Check the values and try again.
              </p>
            ) : null}
            {notice ? (
              <p aria-live="polite" className="m-0 text-sm text-text-secondary">
                {notice}
              </p>
            ) : null}
            <DialogFooter>
              {provider.health === 'ready' ? (
                <Button
                  disabled={saving}
                  onClick={() => void verify()}
                  type="button"
                  variant="secondary"
                >
                  Verify credential
                </Button>
              ) : null}
              {provider.health === 'ready' ? (
                <Button
                  disabled={saving}
                  onClick={() => void disable()}
                  type="button"
                  variant="destructive"
                >
                  Disable provider
                </Button>
              ) : null}
              <Button disabled={saving} type="submit">
                <KeyRound aria-hidden="true" size={16} />
                {saving
                  ? 'Saving…'
                  : provider.health === 'ready'
                    ? 'Update credential'
                    : 'Save credential'}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <p className="m-0 text-sm text-text-muted">
            This provider has no supported credential mode.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
