import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function IconButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      className={`inline-flex size-8 items-center justify-center rounded-md border border-border-strong bg-surface p-0 text-text-secondary hover:bg-surface-strong hover:text-text ${className ?? ''}`}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}
