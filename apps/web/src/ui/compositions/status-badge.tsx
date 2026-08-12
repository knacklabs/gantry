import { Badge, type BadgeVariant } from '../primitives/badge';

const toneByStatus: Record<string, BadgeVariant> = {
  active: 'success',
  accepted: 'success',
  blocked: 'danger',
  completed: 'success',
  connecting: 'attention',
  disconnected: 'danger',
  deployed: 'success',
  draft: 'neutral',
  enabled: 'success',
  failed: 'danger',
  failing: 'danger',
  healthy: 'success',
  offline: 'danger',
  passing: 'success',
  paused: 'attention',
  pending: 'attention',
  quiet: 'neutral',
  not_invited: 'neutral',
  ready: 'success',
  running: 'success',
  live: 'success',
  queued: 'neutral',
  warning: 'attention',
  waiting: 'attention',
  reconnecting: 'attention',
  attention: 'attention',
  degraded: 'attention',
  stale: 'attention',
  unhealthy: 'danger',
  fresh: 'success',
  'not-applicable': 'neutral',
  canceled: 'danger',
  cancelled: 'danger',
  timeout: 'danger',
  timed_out: 'danger',
  needs_attention: 'attention',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={toneByStatus[status] ?? 'neutral'}>
      {formatStatus(status)}
    </Badge>
  );
}

function formatStatus(status: string) {
  return status
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase());
}
