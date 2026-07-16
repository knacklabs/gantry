import type { ReactNode } from 'react';

export function InteractionFrame({
  action,
  children,
  icon,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <section className="grid gap-3 rounded-md border border-border bg-surface p-4">
      <header className="flex min-w-0 items-center justify-between gap-3">
        <h3 className="m-0 inline-flex min-w-0 items-center gap-2 text-[13px] font-semibold text-text">
          {icon}
          {title}
        </h3>
        {action}
      </header>
      {children}
    </section>
  );
}
