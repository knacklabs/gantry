import type { ReactNode } from 'react';

type PanelProps = {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  title?: ReactNode;
};

export function Panel({
  action,
  children,
  className = '',
  description,
  title,
}: PanelProps) {
  return (
    <section
      className={`overflow-hidden rounded-lg border border-border bg-surface shadow-panel ${className}`}
    >
      {title || action ? (
        <header className="flex min-h-12 items-center justify-between gap-4 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            {title ? (
              <h2 className="m-0 truncate text-sm font-semibold text-text">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 mb-0 text-xs text-text-secondary">
                {description}
              </p>
            ) : null}
          </div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}
