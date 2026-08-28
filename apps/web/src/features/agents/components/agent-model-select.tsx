import { useQuery } from '@tanstack/react-query';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../ui/primitives/select';
import { agentModelsQuery } from '../agents-queries';

const DEPLOYMENT_DEFAULT_MODEL = '__deployment_default__';

export function AgentModelSelect({
  value,
  onValueChange,
}: {
  value: string | null;
  onValueChange: (value: string | null) => void;
}) {
  const models = useQuery(agentModelsQuery);
  return (
    <label className="grid gap-1.5 text-xs font-semibold text-text">
      Model
      <Select
        value={value ?? DEPLOYMENT_DEFAULT_MODEL}
        onValueChange={(next) =>
          onValueChange(next === DEPLOYMENT_DEFAULT_MODEL ? null : next)
        }
      >
        <SelectTrigger
          aria-label="Model"
          className="h-9 w-full rounded-md border-border-strong bg-surface px-3 text-[13px] text-text"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={DEPLOYMENT_DEFAULT_MODEL}>
            Use deployment default
          </SelectItem>
          {(models.data?.models ?? []).map((model) => (
            <SelectItem key={model.alias} value={model.alias}>
              {model.displayName} ({model.providerLabel})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
