import { Tabs, TabsList, TabsTrigger } from '../primitives/tabs';

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
    <Tabs value={value} onValueChange={(next) => onValueChange(next as T)}>
      <TabsList
        variant="line"
        aria-label={label}
        className="flex min-w-0 gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((tab) => (
          <TabsTrigger
            className="relative inline-flex h-10 shrink-0 items-center gap-2 border-0 bg-transparent px-3 text-xs font-semibold text-text-secondary hover:text-text data-[state=active]:text-text data-[state=active]:after:absolute data-[state=active]:after:right-2 data-[state=active]:after:bottom-0 data-[state=active]:after:left-2 data-[state=active]:after:h-0.5 data-[state=active]:after:bg-text"
            key={tab.value}
            value={tab.value}
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span className="font-mono text-[10px] text-text-muted">
                {tab.count}
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
