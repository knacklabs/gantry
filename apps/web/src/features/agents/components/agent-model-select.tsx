import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/primitives/select';
import { agentModelsQuery } from '../agents-queries';
import { agentModelLabel } from '../agent-model-label';

const DEPLOYMENT_DEFAULT_PROVIDER = '__deployment_default_provider__';

export function AgentModelSelect({
  disabled = false,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  value: string | null;
  onValueChange: (value: string | null) => void;
}) {
  const models = useQuery(agentModelsQuery);
  const [providerChoice, setProviderChoice] = useState<string | null>(null);
  const catalog = models.data?.models ?? [];
  const selectedModel = catalog.find((model) => model.alias === value);
  const selectedProvider =
    providerChoice ?? selectedModel?.providerId ?? DEPLOYMENT_DEFAULT_PROVIDER;
  const providers = [
    ...new Map(
      catalog.map((model) => [model.providerId, model.providerLabel]),
    ).entries(),
  ];
  const providerModels = catalog.filter(
    (model) => model.providerId === selectedProvider,
  );
  const providerConfigured = providerModels.some((model) => model.configured);

  return (
    <div className="grid gap-3">
      <label className="grid gap-1.5 text-xs font-semibold text-text">
        Model provider
        <Select
          disabled={disabled || models.isPending || models.isError}
          value={selectedProvider}
          onValueChange={(next) => {
            setProviderChoice(next);
            if (next === DEPLOYMENT_DEFAULT_PROVIDER) {
              onValueChange(null);
              return;
            }
            const firstModel = catalog.find(
              (model) => model.providerId === next && model.configured,
            );
            if (firstModel) onValueChange(firstModel.alias);
          }}
        >
          <SelectTrigger
            aria-label="Model provider"
            className="h-9 w-full rounded-md border-border-strong bg-surface px-3 text-[13px] text-text"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value={DEPLOYMENT_DEFAULT_PROVIDER}>
              Use deployment default
            </SelectItem>
            {providers.map(([providerId, providerLabel]) => (
              <SelectItem key={providerId} value={providerId}>
                {providerLabel}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {selectedProvider !== DEPLOYMENT_DEFAULT_PROVIDER ? (
        <label className="grid gap-1.5 text-xs font-semibold text-text">
          Model
          <Select
            disabled={disabled || !providerConfigured}
            value={
              selectedModel?.providerId === selectedProvider
                ? (value ?? undefined)
                : undefined
            }
            onValueChange={onValueChange}
          >
            <SelectTrigger
              aria-label="Model"
              className="h-9 w-full rounded-md border-border-strong bg-surface px-3 text-[13px] text-text"
            >
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent position="popper">
              {providerModels.map((model) => (
                <SelectItem
                  disabled={!model.configured}
                  key={model.alias}
                  value={model.alias}
                >
                  {agentModelLabel(
                    model.displayName,
                    model.providerId,
                    model.providerLabel,
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
      {models.isError ? (
        <p className="m-0 text-xs text-danger" role="alert">
          Models could not be loaded. Refresh this page and try again.
        </p>
      ) : null}
      {selectedProvider !== DEPLOYMENT_DEFAULT_PROVIDER &&
      !providerConfigured &&
      !models.isPending ? (
        <p className="m-0 text-xs text-text-secondary">
          This provider needs a credential before its models can be selected.{' '}
          <Link
            to="/providers"
            search={{
              q: '',
              status: 'all',
              page: 1,
              sort: 'name',
              desc: false,
            }}
          >
            Configure model providers
          </Link>
        </p>
      ) : null}
    </div>
  );
}
