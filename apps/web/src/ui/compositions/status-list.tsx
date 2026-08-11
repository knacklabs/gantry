import type { ReactNode } from 'react';

type StatusTone = 'attention' | 'danger' | 'neutral' | 'success';

const dotClasses: Record<StatusTone, string> = {
  attention: 'bg-status-attention',
  danger: 'bg-danger',
  neutral: 'bg-border-strong',
  success: 'bg-status-success',
};

export type StatusListItem = {
  action?: ReactNode;
  detail?: ReactNode;
  id: string;
  label: ReactNode;
  meta?: ReactNode;
  tone?: StatusTone;
};

export function StatusList({ items }: { items: StatusListItem[] }) {
  return (
    <ul className="m-0 list-none p-0">
      {items.map(({ action, detail, id, label, meta, tone = 'neutral' }) => (
        <li
          className="grid min-h-14 grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
          key={id}
        >
          <span
            className={`size-1.5 rounded-full ${dotClasses[tone]}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            {meta ? (
              <div className="font-mono text-[10px] text-text-muted">
                {meta}
              </div>
            ) : null}
            <div className="text-[13px] font-semibold text-text">{label}</div>
            {detail ? (
              <div className="mt-0.5 text-xs text-text-secondary">{detail}</div>
            ) : null}
          </div>
          {action}
        </li>
      ))}
    </ul>
  );
}
