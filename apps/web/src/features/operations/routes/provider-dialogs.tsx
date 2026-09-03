import { useQueryClient } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
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
import { Textarea } from '../../../ui/primitives/textarea';
import { SelectField } from '../../../ui/compositions/select-field';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../../../ui/primitives/tooltip';
import { type ModelProvider, modelProviderQuery } from '../operations-queries';
import { navigationSummaryQuery } from '../../navigation/navigation-summary-query';

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
        'An active credential is stored. Check its Gantry configuration before use.',
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
  const [removalConfirmation, setRemovalConfirmation] = useState('');
  const [removalOpen, setRemovalOpen] = useState(false);
  const [selectedModeId, setSelectedModeId] = useState('');
  useEffect(() => {
    if (!provider) {
      setSelectedModeId('');
      setError(null);
      setNotice(null);
      return;
    }
    setSelectedModeId(
      provider.authMode ??
        (provider.credentialModes.length === 1
          ? (provider.credentialModes[0]?.id ?? '')
          : ''),
    );
  }, [provider?.providerId, provider?.authMode]);
  const mode = provider?.credentialModes.find(
    (item) => item.id === selectedModeId,
  );
  const isDisabled = provider?.health === 'disabled';
  const isSameMode = Boolean(provider && mode && provider.authMode === mode.id);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || !mode) return;
    setError(null);
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(
      mode.fields.flatMap((field) => {
        const value = String(form.get(field.name) ?? '').trim();
        return value ? [[field.name, value]] : [];
      }),
    );
    if (isSameMode && !isDisabled && Object.keys(payload).length === 0) {
      setError('Enter a value to update this credential.');
      return;
    }
    setSaving(true);
    const response = await browserFetch(
      `/ui/api/model-providers/${encodeURIComponent(provider.providerId)}`,
      {
        method: isSameMode ? 'PATCH' : 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          ...browserCsrfHeader(),
        },
        body: JSON.stringify({
          ...(isSameMode ? {} : { authMode: mode.id }),
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
    await queryClient.invalidateQueries({
      queryKey: navigationSummaryQuery.queryKey,
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
      setError('Configuration check could not be completed.');
      return;
    }
    setNotice(body?.message ?? 'Configuration check finished.');
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
    await queryClient.invalidateQueries({
      queryKey: navigationSummaryQuery.queryKey,
    });
    onOpenChange(false);
  }

  async function remove() {
    if (!provider || removalConfirmation !== provider.label) return;
    setSaving(true);
    setError(null);
    const response = await browserFetch(
      `/ui/api/model-providers/${encodeURIComponent(provider.providerId)}/credential`,
      {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: browserCsrfHeader(),
      },
    );
    setSaving(false);
    if (!response.ok) {
      setError('Credential could not be removed.');
      return;
    }
    await queryClient.invalidateQueries({
      queryKey: modelProviderQuery.queryKey,
    });
    await queryClient.invalidateQueries({
      queryKey: navigationSummaryQuery.queryKey,
    });
    setRemovalConfirmation('');
    setRemovalOpen(false);
    onOpenChange(false);
  }

  return (
    <>
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
                ? 'Save changes to re-enable this provider.'
                : 'Credential values are write-only and are never shown again.'}
            </DialogDescription>
          </DialogHeader>
          {provider ? (
            <form
              className="grid gap-4"
              key={`${provider.providerId}:${selectedModeId}`}
              onSubmit={submit}
            >
              {provider.requiredBy.length > 0 ? (
                <p className="m-0 text-sm text-text-muted">
                  Required for {provider.requiredBy.join(', ')}.
                </p>
              ) : null}
              {provider.credentialModes.length > 1 ? (
                <SelectField
                  label="Authentication method"
                  onValueChange={(next) => {
                    setSelectedModeId(next);
                    setError(null);
                    setNotice(null);
                  }}
                  options={provider.credentialModes.map((item) => ({
                    label: item.label,
                    value: item.id,
                  }))}
                  placeholder="Choose a method"
                  value={selectedModeId}
                />
              ) : null}
              {mode ? (
                <>
                  <p className="m-0 text-sm text-text-secondary">
                    {mode.helpText}
                  </p>
                  {isSameMode ? (
                    <p className="m-0 text-sm text-text-muted">
                      Leave a field blank to keep its stored value.
                    </p>
                  ) : provider.authMode ? (
                    <p className="m-0 text-sm text-text-muted">
                      Changing methods replaces the stored credential. Enter
                      every required field for the new method.
                    </p>
                  ) : null}
                  {mode.fields.map((field) => (
                    <label
                      className="grid gap-1.5 text-sm font-medium"
                      key={field.name}
                    >
                      <span>
                        {field.label}
                        {provider.configuredFields.includes(field.name)
                          ? ' (stored)'
                          : ''}
                      </span>
                      {field.multiline ? (
                        <Textarea
                          name={field.name}
                          required={!isSameMode && field.required}
                        />
                      ) : (
                        <Input
                          name={field.name}
                          required={!isSameMode && field.required}
                          type={field.secret ? 'password' : 'text'}
                        />
                      )}
                    </label>
                  ))}
                </>
              ) : (
                <p className="m-0 text-sm text-text-muted">
                  Choose an authentication method to continue.
                </p>
              )}
              {provider.health === 'ready' ? (
                <div className="grid gap-2 rounded-md border border-danger/40 bg-danger/5 p-3">
                  <div>
                    <p className="m-0 text-sm font-semibold text-danger">
                      Danger zone
                    </p>
                    <p className="m-0 text-sm text-text-secondary">
                      Permanently delete this stored credential and its
                      encrypted secret.
                    </p>
                  </div>
                  <div>
                    <Button
                      disabled={saving}
                      onClick={() => setRemovalOpen(true)}
                      type="button"
                      variant="destructive"
                    >
                      Remove credential…
                    </Button>
                  </div>
                </div>
              ) : null}
              {error ? (
                <p aria-live="polite" className="m-0 text-sm text-danger">
                  {error} Check the values and try again.
                </p>
              ) : null}
              {notice ? (
                <p
                  aria-live="polite"
                  className="m-0 text-sm text-text-secondary"
                >
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
                    Check configuration
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
                <Button disabled={saving || !mode} type="submit">
                  <KeyRound aria-hidden="true" size={16} />
                  {saving
                    ? 'Saving…'
                    : provider.health === 'ready'
                      ? 'Update credential'
                      : isDisabled
                        ? 'Re-enable provider'
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
      <Dialog
        open={removalOpen}
        onOpenChange={(open) => {
          setRemovalOpen(open);
          if (!open) setRemovalConfirmation('');
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {provider?.label} credential?</DialogTitle>
            <DialogDescription>
              This permanently deletes the stored encrypted credential. Gantry
              will not use this provider until a new credential is added.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Type {provider?.label} to confirm
              <Input
                onChange={(event) => setRemovalConfirmation(event.target.value)}
                value={removalConfirmation}
              />
            </label>
            {error ? (
              <p aria-live="polite" className="m-0 text-sm text-danger">
                {error} Try again or cancel this action.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              onClick={() => setRemovalOpen(false)}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={saving || removalConfirmation !== provider?.label}
              onClick={() => void remove()}
              type="button"
              variant="destructive"
            >
              Remove credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
