import { useId } from 'react';

import { Field, FieldLabel } from '../primitives/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../primitives/select';

export type SelectOption<T extends string> = {
  label: string;
  value: T;
};

export function SelectField<T extends string>({
  disabled = false,
  invalid = false,
  label,
  onValueChange,
  options,
  placeholder,
  value,
}: {
  disabled?: boolean;
  invalid?: boolean;
  label: string;
  onValueChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  placeholder?: string;
  value: T;
}) {
  const id = useId();
  return (
    <Field
      data-disabled={disabled || undefined}
      data-invalid={invalid || undefined}
    >
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        disabled={disabled}
        onValueChange={(next) => onValueChange(next as T)}
        value={value}
      >
        <SelectTrigger
          aria-invalid={invalid || undefined}
          className="w-full"
          id={id}
        >
          <SelectValue placeholder={placeholder ?? label} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}
