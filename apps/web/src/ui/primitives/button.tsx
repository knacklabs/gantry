import type { ComponentPropsWithRef } from 'react';

type ButtonVariant = 'danger' | 'ghost' | 'primary' | 'secondary';
type ButtonSize = 'md' | 'sm';

const variantClasses: Record<ButtonVariant, string> = {
  danger: 'border-danger bg-transparent text-danger hover:bg-danger-soft',
  ghost:
    'border-transparent bg-transparent text-text-secondary hover:bg-surface-strong hover:text-text',
  primary: 'border-ink bg-ink text-ink-on hover:bg-ink-hover',
  secondary: 'border-border-strong bg-surface text-text hover:bg-surface-muted',
};

const sizeClasses: Record<ButtonSize, string> = {
  md: 'h-9 px-3.5 text-[13px]',
  sm: 'h-8 px-2.5 text-xs',
};

type ButtonProps = ComponentPropsWithRef<'button'> & {
  size?: ButtonSize;
  variant?: ButtonVariant;
};

export function Button({
  className = '',
  size = 'md',
  type = 'button',
  variant = 'secondary',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-md border font-semibold transition-colors disabled:pointer-events-none disabled:opacity-45 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      type={type}
      {...props}
    />
  );
}
