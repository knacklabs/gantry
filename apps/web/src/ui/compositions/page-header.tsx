import type { ReactNode } from 'react';

export function PageHeader({
  action,
  description,
  eyebrow,
  id = 'page-title',
  title,
}: {
  action?: ReactNode;
  description?: ReactNode;
  eyebrow?: string;
  id?: string;
  title: ReactNode;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <span className="font-mono text-micro font-medium tracking-[0.18em] text-text-muted uppercase">
            {eyebrow}
          </span>
        ) : null}
        <h1
          className="mt-1 mb-0 font-display text-section font-bold tracking-[-0.04em] text-text"
          id={id}
        >
          {title}
        </h1>
        {description ? (
          <p className="mt-[5px] mb-0 max-w-3xl text-ui text-text-secondary">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </header>
  );
}
