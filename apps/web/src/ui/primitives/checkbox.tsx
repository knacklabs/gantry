import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from 'lucide-react';

export function Checkbox({
  checked,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-3 text-[13px] leading-5 text-text"
      htmlFor={id}
    >
      <CheckboxPrimitive.Root
        checked={checked}
        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border border-border-strong bg-surface text-ink-on data-[state=checked]:border-ink data-[state=checked]:bg-ink"
        id={id}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      >
        <CheckboxPrimitive.Indicator>
          <Check size={14} strokeWidth={2.5} aria-hidden="true" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <span>{label}</span>
    </label>
  );
}
