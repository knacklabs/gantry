import { CircleCheck, CircleOff } from 'lucide-react';

import { useRuntimeConnection } from '../../lib/api/runtime-connection';
import { Badge } from '../primitives/badge';

export function ConnectionState() {
  const connection = useRuntimeConnection();
  const connected = connection.mode === 'local-owner';
  const label = connected ? 'Local owner' : 'Not connected';
  const Icon = connected ? CircleCheck : CircleOff;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge tone={connected ? 'success' : 'attention'}>
        {connected ? 'Live runtime' : 'UI preview'}
      </Badge>
      <span
        aria-label={`Runtime connection: ${label.toLowerCase()}`}
        title={connection.discoveryError}
        className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-medium text-text-secondary"
      >
        <Icon
          className={
            connected
              ? 'shrink-0 text-status-success'
              : 'shrink-0 text-status-idle'
          }
          size={14}
          aria-hidden="true"
        />
        <span className="max-[420px]:sr-only">{label}</span>
      </span>
    </div>
  );
}
