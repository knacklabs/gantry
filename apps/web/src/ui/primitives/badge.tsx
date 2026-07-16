import type { ComponentPropsWithoutRef } from 'react';

export type BadgeTone = 'attention' | 'danger' | 'neutral' | 'success';

const toneClasses: Record<BadgeTone, string> = {
  attention:
    'border-status-attention/50 bg-status-attention-soft text-status-attention',
  danger: 'border-danger/50 bg-danger-soft text-danger',
  neutral: 'border-border-strong bg-surface-strong text-text-secondary',
  success:
    'border-status-success/50 bg-status-success-soft text-status-success',
};

type BadgeProps = ComponentPropsWithoutRef<'span'> & {
  tone?: BadgeTone;
};

export function Badge({
  className = '',
  tone = 'neutral',
  ...props
}: BadgeProps) {
  return (
    <span
      className={`inline-flex min-h-5 items-center gap-1 rounded-full border px-2 font-mono text-[10px] leading-4 font-semibold ${toneClasses[tone]} ${className}`}
      {...props}
    />
  );
}
