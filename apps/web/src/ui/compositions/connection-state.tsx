import { CircleOff } from 'lucide-react';

import { Badge } from '../primitives/badge';

export function ConnectionState() {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Badge tone="attention">Preview data</Badge>
      <span
        aria-label="Runtime connection: not connected"
        className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] font-medium text-text-secondary"
      >
        <CircleOff
          className="shrink-0 text-status-idle"
          size={14}
          aria-hidden="true"
        />
        <span className="max-[420px]:sr-only">Not connected</span>
      </span>
    </div>
  );
}
