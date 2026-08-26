import React from 'react';

const SIZES = {
  md: { height: 'var(--btn-height, 44px)', padding: '0 22px', fontSize: 15 },
  sm: { height: 'var(--btn-height-sm, 36px)', padding: '0 16px', fontSize: 14 },
};

const VARIANTS = {
  // On light surfaces
  primary: {
    base: { background: 'var(--kl-emerald)', color: '#fff', border: '1px solid var(--kl-emerald)' },
    hover: { background: 'var(--kl-deep-forest)', borderColor: 'var(--kl-deep-forest)' },
  },
  secondary: {
    base: { background: '#fff', color: 'var(--kl-emerald)', border: '1px solid var(--kl-emerald)' },
    hover: { background: 'rgba(28,107,73,.08)' },
  },
  // On dark (Deep Forest) surfaces
  'dark-primary': {
    base: { background: 'var(--kl-mint)', color: 'var(--kl-deep-forest)', border: '1px solid var(--kl-mint)' },
    hover: { filter: 'brightness(1.06)' },
  },
  'dark-ghost': {
    base: { background: 'transparent', color: '#fff', border: '1px solid rgba(255,255,255,.35)' },
    hover: { borderColor: 'var(--kl-mint)', color: 'var(--kl-mint)' },
  },
};

export function Button({ variant = 'primary', size = 'md', mono = false, href, onClick, style, children }) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const v = VARIANTS[variant] || VARIANTS.primary;
  const s = SIZES[size] || SIZES.md;
  const css = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontFamily: mono ? 'var(--font-mono, "JetBrains Mono", monospace)' : 'var(--font-sans)',
    fontWeight: 600, fontSize: mono ? s.fontSize - 1 : s.fontSize,
    letterSpacing: mono ? '0.01em' : 'normal',
    height: s.height, padding: s.padding, borderRadius: 'var(--radius-md, 10px)',
    cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap', boxSizing: 'border-box',
    transition: 'background .2s ease, border-color .2s ease, color .2s ease, filter .2s ease, transform .15s ease',
    transform: press ? 'scale(.98)' : 'none',
    ...v.base, ...(hover ? v.hover : null), ...style,
  };
  const Tag = href ? 'a' : 'button';
  return (
    <Tag
      href={href} onClick={onClick} style={css}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)} onMouseUp={() => setPress(false)}
    >
      {children}
    </Tag>
  );
}
