import type { ReactNode } from 'react';

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '../primitives/alert';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '../primitives/empty';
import { Skeleton } from '../primitives/skeleton';

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
  if (kind === 'loading') {
    return (
      <div
        aria-busy="true"
        aria-label={title}
        className="grid min-h-36 gap-3 rounded-lg border border-border bg-surface p-6"
      >
        <Skeleton className="h-10 w-10" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-3 w-full max-w-md" />
      </div>
    );
  }

  if (kind === 'error') {
    return (
      <Alert
        className="min-h-36 items-center border-danger/40 bg-danger-soft p-6"
        variant="destructive"
      >
        {icon}
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{description}</AlertDescription>
        {action ? <AlertAction>{action}</AlertAction> : null}
      </Alert>
    );
  }

  return (
    <Empty className="min-h-36 rounded-lg border border-border bg-surface p-6 text-left max-sm:min-h-0">
      <EmptyHeader className="max-w-none flex-row items-center gap-4 text-left">
        <EmptyMedia className={iconColorClassName(kind)} variant="icon">
          {icon}
        </EmptyMedia>
        <div className="min-w-0 flex-1">
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </div>
      </EmptyHeader>
      {action ? (
        <EmptyContent className="max-w-none items-end">{action}</EmptyContent>
      ) : null}
    </Empty>
  );
}

function iconColorClassName(kind: PageStateKind): string {
  if (kind === 'error') return 'text-danger';
  if (kind === 'offline') return 'text-status-idle';
  return 'text-text-secondary';
}
