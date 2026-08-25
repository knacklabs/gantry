import type { CSSProperties } from 'react';

const markUrl = `${import.meta.env.BASE_URL}brand/gantry-mark.svg?v=23-4`;

const maskStyle: CSSProperties = {
  maskImage: `url(${markUrl})`,
  maskPosition: 'center',
  maskRepeat: 'no-repeat',
  maskSize: 'contain',
  WebkitMaskImage: `url(${markUrl})`,
  WebkitMaskPosition: 'center',
  WebkitMaskRepeat: 'no-repeat',
  WebkitMaskSize: 'contain',
};

export function GantryMark({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 bg-current ${className}`}
      style={maskStyle}
    />
  );
}
