import { CheckCircle2, Clock3, FileText, Info } from 'lucide-react';

import { useConnectionGate } from '../../../ui/compositions/connection-gate';
import { StatusBadge } from '../../../ui/compositions/status-badge';
import { Button } from '../../../ui/primitives/button';
import type {
  ChatMessagePreview,
  ChatSessionPreview,
  InteractionPreview,
} from '../chat-preview';

export type ChatInspectorTab = 'thread' | 'timeline' | 'files';
type TimelineItem = Extract<
  InteractionPreview,
  { kind: 'todo' | 'progress' | 'receipt' }
>;

export function ChatInspector({
  messages,
  session,
  tab,
}: {
  messages: ChatMessagePreview[];
  session: ChatSessionPreview;
  tab: ChatInspectorTab;
}) {
  const { requestConnection } = useConnectionGate();
  const descriptors = messages.flatMap((message) => message.descriptors ?? []);

  if (tab === 'thread') {
    return (
      <div className="grid gap-4 p-4">
        <Detail label="Agent" value={session.agent} />
        <Detail label="Conversation" value={session.conversation} />
        <Detail
          label="Status"
          value={<StatusBadge status={session.status} />}
        />
        <Detail label="Last activity" value={session.activity} />
        <div className="border-t border-border pt-4">
          <Button
            className="w-full"
            variant="secondary"
            onClick={() =>
              requestConnection(`Open runtime detail for ${session.title}`)
            }
          >
            <Info size={15} aria-hidden="true" /> Runtime detail
          </Button>
        </div>
      </div>
    );
  }

  if (tab === 'files') {
    const files = descriptors.filter(
      (descriptor) => descriptor.kind === 'file',
    );
    return (
      <div className="grid gap-2 p-4">
        {files.length ? (
          files.map((file) => (
            <button
              className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border border-border px-3 text-left hover:bg-surface-muted"
              key={file.name}
              type="button"
              onClick={() => requestConnection(`Download ${file.name}`)}
            >
              <FileText size={17} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-text">
                  {file.name}
                </span>
                <span className="font-mono text-[10px] text-text-muted">
                  {file.mediaType} · {file.size}
                </span>
              </span>
            </button>
          ))
        ) : (
          <p className="m-0 py-8 text-center text-xs text-text-secondary">
            No files in this session.
          </p>
        )}
      </div>
    );
  }

  const timeline = descriptors.filter(isTimelineItem);
  return (
    <div className="grid gap-4 p-4">
      {timeline.length ? (
        timeline.map((item, index) => (
          <div
            className="grid grid-cols-[20px_minmax(0,1fr)] gap-3"
            key={`${item.kind}-${index}`}
          >
            <span
              className={
                item.kind === 'receipt'
                  ? 'text-status-success'
                  : 'text-status-attention'
              }
            >
              {item.kind === 'receipt' ? (
                <CheckCircle2 size={16} aria-hidden="true" />
              ) : (
                <Clock3 size={16} aria-hidden="true" />
              )}
            </span>
            <span>
              <strong className="block text-[13px] text-text">
                {timelineTitle(item)}
              </strong>
              <span className="mt-1 block text-xs leading-5 text-text-secondary">
                {timelineDetail(item)}
              </span>
            </span>
          </div>
        ))
      ) : (
        <p className="m-0 py-8 text-center text-xs text-text-secondary">
          No run timeline is represented.
        </p>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-border pb-3 last:border-0">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-[13px] font-medium text-text">{value}</span>
    </div>
  );
}

function isTimelineItem(item: InteractionPreview): item is TimelineItem {
  return (
    item.kind === 'todo' || item.kind === 'progress' || item.kind === 'receipt'
  );
}

function timelineTitle(item: TimelineItem) {
  if (item.kind === 'todo') return item.title;
  if (item.kind === 'progress') return item.label;
  return 'Result receipt';
}

function timelineDetail(item: TimelineItem) {
  if (item.kind === 'todo')
    return `${item.items.filter((entry) => entry.status === 'done').length} of ${item.items.length} steps complete`;
  if (item.kind === 'progress') return item.detail;
  return item.outcome;
}
