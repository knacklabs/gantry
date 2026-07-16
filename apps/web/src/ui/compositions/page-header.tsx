import type { ReactNode } from 'react';

export function PageHeader({
  action,
  description,
  eyebrow,
  id,
  title,
}: {
  action?: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  id: string;
  title: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <span className="font-mono text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
            {eyebrow}
          </span>
        ) : null}
        <h1
          className="mt-1 mb-0 text-2xl leading-tight font-semibold text-text"
          id={id}
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-1 mb-0 max-w-3xl text-[13px] text-text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </header>
  );
}
