import type { AriaAttributes, ComponentType } from 'react';

type Option<T extends string> = {
  icon: ComponentType<{
    size?: number;
    'aria-hidden'?: AriaAttributes['aria-hidden'];
  }>;
  label: string;
  value: T;
};

export function SegmentedControl<T extends string>({
  'aria-label': ariaLabel,
  onValueChange,
  options,
  value,
}: {
  'aria-label': string;
  onValueChange: (value: T) => void;
  options: Option<T>[];
  value: T;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="inline-flex gap-0.5 rounded-lg border border-border bg-surface-muted p-0.5"
      role="group"
    >
      {options.map(({ icon: Icon, label, value: optionValue }) => (
        <button
          aria-pressed={optionValue === value}
          className={[
            'inline-flex h-8 items-center gap-1.5 rounded-[5px] border px-2.5 text-xs font-semibold',
            'max-[450px]:w-9 max-[450px]:justify-center max-[450px]:px-0',
            optionValue === value
              ? 'border-border-strong bg-surface text-text shadow-control'
              : 'border-transparent bg-transparent text-text-secondary hover:text-text',
          ].join(' ')}
          key={optionValue}
          onClick={() => onValueChange(optionValue)}
          type="button"
        >
          <Icon aria-hidden="true" size={14} />
          <span className="max-[450px]:sr-only">{label}</span>
        </button>
      ))}
    </div>
  );
}
