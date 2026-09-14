import { CircleAlert, Check, Copy } from 'lucide-react';
import { useState, type ComponentProps } from 'react';

import { Button } from './button';

type CopyButtonProps = Omit<
  ComponentProps<typeof Button>,
  'children' | 'onClick'
> & {
  value: string;
  label?: string;
};

export function CopyButton({
  label = 'Copy',
  value,
  ...props
}: CopyButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setStatus('copied');
    } catch {
      setStatus('failed');
    }
  }

  const copied = status === 'copied';
  const failed = status === 'failed';
  return (
    <>
      <Button {...props} onClick={() => void copy()} type="button">
        {copied ? (
          <Check aria-hidden="true" />
        ) : failed ? (
          <CircleAlert aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
        {copied ? 'Copied' : failed ? 'Copy failed' : label}
      </Button>
      <span className="sr-only" role="status">
        {status === 'failed' ? 'Copy failed.' : copied ? 'Copied.' : ''}
      </span>
    </>
  );
}
