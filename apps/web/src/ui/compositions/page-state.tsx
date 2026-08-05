import type { ReactNode } from 'react';

type PageStateKind = 'empty' | 'error' | 'loading' | 'offline' | 'reconnecting';

export function PageState({
  action,
  description,
  icon,
  kind,
  title,
}: {
  action?: ReactNode;
  description: string;
  icon: ReactNode;
  kind: PageStateKind;
  title: string;
}) {
  return (
    <div className="flex min-h-36 items-center justify-between gap-4 rounded-lg border border-border bg-surface p-6 max-sm:min-h-0 max-sm:flex-wrap max-sm:items-start">
      <span
        className={`inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface-strong ${iconColorClassName(kind)}`}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="m-0 text-sm font-semibold">{title}</h2>
        <p className="mt-1.5 mb-0 text-[13px] leading-5 text-text-secondary">
          {description}
        </p>
      </div>
      {action ? <div className="shrink-0 max-sm:ml-14">{action}</div> : null}
    </div>
  );
}

function iconColorClassName(kind: PageStateKind): string {
  if (kind === 'error') return 'text-danger';
  if (kind === 'offline') return 'text-status-idle';
  return 'text-text-secondary';
}
