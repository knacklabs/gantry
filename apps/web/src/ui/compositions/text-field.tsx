import type { ComponentPropsWithRef, ReactNode } from 'react';

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
    <label className="grid gap-1.5" htmlFor={id}>
      <span className="text-xs font-semibold text-text">{label}</span>
      <input
        aria-describedby={descriptionId}
        aria-invalid={error ? true : undefined}
        className={`h-9 w-full rounded-md border bg-surface px-3 text-[13px] text-text placeholder:text-text-muted ${error ? 'border-danger' : 'border-border-strong'} ${className}`}
        id={id}
        {...props}
      />
      {error || hint ? (
        <span
          className={`text-xs leading-5 ${error ? 'text-danger' : 'text-text-muted'}`}
          id={descriptionId}
        >
          {error ?? hint}
        </span>
      ) : null}
    </label>
  );
}
