import React from 'react';

/* Mono label chip for isometric diagrams (Brand Book 08: JetBrains Mono,
   real metrics). Tones stay inside the brand: mint tint, outline, slate. */
export function IsoLabel({ tone = 'tint', size = 'md', style, children }) {
  const tones = {
    tint: { background: 'rgba(106,241,176,.16)', border: '1px solid var(--kl-emerald, #1C6B49)', color: 'var(--kl-deep-forest, #0C3529)' },
    outline: { background: '#fff', border: '1px solid var(--kl-emerald, #1C6B49)', color: 'var(--kl-deep-forest, #0C3529)' },
    slate: { background: '#fff', border: '1px solid rgba(95,112,106,.5)', color: 'var(--kl-slate, #5F706A)' },
    solid: { background: 'var(--kl-emerald, #1C6B49)', border: '1px solid var(--kl-emerald, #1C6B49)', color: '#fff' },
  };
  const t = tones[tone] || tones.tint;
  return (
    <span style={{
      display: 'inline-block', fontFamily: 'var(--font-mono)', fontWeight: 500,
      fontSize: size === 'sm' ? 9.5 : 11.5, letterSpacing: '.08em', textTransform: 'uppercase',
      padding: size === 'sm' ? '2px 6px' : '4px 9px', whiteSpace: 'nowrap',
      boxShadow: '0 1px 0 rgba(12,53,41,.06)', ...t, ...style,
    }}>
      {children}
    </span>
  );
}
