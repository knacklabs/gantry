import React from 'react';

export function Eyebrow({ onDark = false, size = 'md', style, children }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)',
      fontSize: size === 'lg' ? 15 : 13,
      letterSpacing: 'var(--tracking-eyebrow, .22em)',
      textTransform: 'uppercase',
      fontWeight: 500,
      color: onDark ? 'var(--kl-mint)' : 'var(--kl-emerald)',
      ...style,
    }}>
      {children}
    </div>
  );
}
