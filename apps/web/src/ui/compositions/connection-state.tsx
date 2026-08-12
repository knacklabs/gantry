import { useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleDotDashed, CircleOff } from 'lucide-react';

import { connectionQuery } from '../../lib/ui-api';
import { Badge } from '../primitives/badge';

export function ConnectionState() {
  const query = useQuery(connectionQuery);
  const stale = query.isError && Boolean(query.data);
  const label = query.isPending
    ? 'Connecting'
    : stale
      ? 'Stale'
      : query.data
        ? 'Connected'
        : 'Disconnected';

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge
        variant={
          query.isPending || stale
            ? 'attention'
            : query.data
              ? 'success'
              : 'danger'
        }
      >
        {label}
      </Badge>
      <span
        aria-label={`Runtime connection: ${label.toLowerCase()}`}
        className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-medium text-text-secondary"
        role="status"
      >
        {query.isPending ? (
          <CircleDotDashed
            className="shrink-0 text-status-attention"
            size={14}
            aria-hidden="true"
          />
        ) : query.data && !stale ? (
          <CircleCheck
            className="shrink-0 text-status-success"
            size={14}
            aria-hidden="true"
          />
        ) : (
          <CircleOff
            className="shrink-0 text-status-idle"
            size={14}
            aria-hidden="true"
          />
        )}
        <span className="max-[420px]:sr-only">{label}</span>
      </span>
    </div>
  );
}
