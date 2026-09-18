import type { ReactNode } from 'react';

import { Card, CardHeader } from '../primitives/card';

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
    <Card
      className={`gap-0 overflow-hidden rounded-[11px] border border-border bg-surface py-0 text-text ring-0 shadow-panel ${className}`}
    >
      {title || action ? (
        <CardHeader className="flex min-h-[58px] items-center justify-between gap-4 rounded-none border-b border-border px-6 py-2.5">
          <div className="min-w-0">
            {title ? (
              <h2 className="m-0 truncate font-mono text-caption font-medium tracking-[0.14em] text-text-secondary uppercase">
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 mb-0 text-meta text-text-muted">
                {description}
              </p>
            ) : null}
          </div>
          {action}
        </CardHeader>
      ) : null}
      {children}
    </Card>
  );
}
