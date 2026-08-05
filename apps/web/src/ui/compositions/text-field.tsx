import type { ComponentPropsWithRef, ReactNode } from 'react';

import { Field, FieldDescription, FieldLabel } from '../primitives/field';
import { Input } from '../primitives/input';

type TextFieldProps = Omit<ComponentPropsWithRef<'input'>, 'id'> & {
  error?: string;
  hint?: ReactNode;
  id: string;
  label: string;
};

export function TextField({
  className = '',
  error,
  hint,
  id,
  label,
  ...props
}: TextFieldProps) {
  const descriptionId = error || hint ? `${id}-description` : undefined;

  return (
    <Field data-invalid={error ? true : undefined} className="gap-1.5">
      <FieldLabel className="text-xs font-semibold text-text" htmlFor={id}>
        {label}
      </FieldLabel>
      <Input
        aria-describedby={descriptionId}
        aria-invalid={error ? true : undefined}
        className={`h-9 rounded-md bg-surface px-3 text-[13px] text-text ${className}`}
        id={id}
        {...props}
      />
      {error || hint ? (
        <FieldDescription
          className={`text-xs leading-5 ${error ? 'text-danger' : 'text-text-muted'}`}
          id={descriptionId}
        >
          {error ?? hint}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
