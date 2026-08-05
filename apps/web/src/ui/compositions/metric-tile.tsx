import type { ReactNode } from 'react';

type MetricTileProps = {
  detail: ReactNode;
  label: ReactNode;
  value: ReactNode;
};

export function MetricTile({ detail, label, value }: MetricTileProps) {
  return (
    <section className="min-h-[92px] rounded-lg border border-border bg-surface px-4 py-3 shadow-panel">
      <div className="font-mono text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">
        {label}
      </div>
      <div className="mt-1 text-2xl leading-none font-semibold text-text">
        {value}
      </div>
      <div className="mt-2 text-xs text-text-secondary">{detail}</div>
    </section>
  );
}
