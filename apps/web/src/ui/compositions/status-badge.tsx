import { Badge, type BadgeTone } from '../primitives/badge';

const toneByStatus: Record<string, BadgeTone> = {
  active: 'success',
  blocked: 'danger',
  deployed: 'success',
  draft: 'neutral',
  failing: 'danger',
  healthy: 'success',
  offline: 'danger',
  passing: 'success',
  paused: 'attention',
  quiet: 'neutral',
  ready: 'success',
  warning: 'attention',
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
