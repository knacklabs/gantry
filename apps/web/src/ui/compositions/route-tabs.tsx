export type RouteTab<T extends string> = {
  label: string;
  value: T;
  count?: number;
};

export function RouteTabs<T extends string>({
  label,
  tabs,
  value,
  onValueChange,
}: {
  label: string;
  tabs: readonly RouteTab<T>[];
  value: T;
  onValueChange: (value: T) => void;
}) {
  return (
    <div
      aria-label={label}
      className="flex min-w-0 gap-1 overflow-x-auto border-b border-border"
      role="group"
    >
      {tabs.map((tab) => (
        <button
          aria-pressed={tab.value === value}
          className="relative inline-flex h-10 shrink-0 items-center gap-2 border-0 bg-transparent px-3 text-xs font-semibold text-text-secondary hover:text-text aria-pressed:text-text aria-pressed:after:absolute aria-pressed:after:right-2 aria-pressed:after:bottom-0 aria-pressed:after:left-2 aria-pressed:after:h-0.5 aria-pressed:after:bg-text"
          key={tab.value}
          type="button"
          onClick={() => onValueChange(tab.value)}
        >
          {tab.label}
          {tab.count === undefined ? null : (
            <span className="font-mono text-[10px] text-text-muted">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
