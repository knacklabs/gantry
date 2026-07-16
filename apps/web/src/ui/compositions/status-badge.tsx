import { Badge, type BadgeTone } from '../primitives/badge';

const toneByStatus: Record<string, BadgeTone> = {
  active: 'success',
  accepted: 'success',
  blocked: 'danger',
  completed: 'success',
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
  queued: 'neutral',
  warning: 'attention',
  waiting: 'attention',
  attention: 'attention',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={toneByStatus[status] ?? 'neutral'}>
      {formatStatus(status)}
    </Badge>
  );
}

function formatStatus(status: string) {
  return status
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase());
}
