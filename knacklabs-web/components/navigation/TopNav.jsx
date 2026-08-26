import React from 'react';
import { Button } from '../core/Button.jsx';

/* Deep Forest top navigation — the brand anchor. The one dark element
   inside a light page; White / Mint accents are allowed here. */
export function TopNav({
  links = ['Offerings', 'How it’s built', 'Work', 'About'],
  active = '',
  logoSrc = 'assets/logos/KL-Logo-Full-White.png',
  logoHref = '#',
  cta = 'Talk to us',
  ctaHref,
  onCta,
  sticky = true,
  style,
}) {
  const [hovered, setHovered] = React.useState(null);
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    const onS = () => setScrolled(window.scrollY > 8);
    onS();
    window.addEventListener('scroll', onS, { passive: true });
    return () => window.removeEventListener('scroll', onS);
  }, []);
  const [narrow, setNarrow] = React.useState(typeof window !== 'undefined' && window.innerWidth < 700);
  React.useEffect(() => {
    const onR = () => setNarrow(window.innerWidth < 700);
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  return (
    <nav style={{
      background: scrolled ? 'rgba(12,53,41,.72)' : 'var(--kl-deep-forest)',
      backdropFilter: 'blur(16px) saturate(1.5)',
      WebkitBackdropFilter: 'blur(16px) saturate(1.5)',
      borderBottom: scrolled ? '1px solid rgba(106,241,176,.16)' : '1px solid transparent',
      boxShadow: scrolled ? '0 8px 28px rgba(10,44,34,.28)' : 'none',
      transition: 'background .35s ease, border-color .35s ease, box-shadow .35s ease',
      position: sticky ? 'sticky' : 'static', top: 0, zIndex: 100,
      display: 'flex', alignItems: 'center',
      gap: narrow ? 16 : 32, padding: narrow ? '0 20px' : '0 32px', height: 68, fontFamily: 'var(--font-sans)',
      boxSizing: 'border-box', ...style,
    }}>
      <a href={logoHref} onClick={(e) => { if (logoHref === '#') e.preventDefault(); }} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <img src={logoSrc} alt="KnackLabs" style={{ height: narrow ? 30 : 34, display: 'block' }} />
      </a>
      <div style={{ flex: 1, display: 'flex', gap: 26, justifyContent: 'flex-end', alignItems: 'center' }}>
        {!narrow && links.map((l) => {
          const label = typeof l === 'string' ? l : l.label;
          const href = typeof l === 'string' ? '#' : (l.href || '#');
          const isActive = label === active;
          const isHover = label === hovered;
          return (
            <a key={label} href={href} onClick={(e) => { if (href === '#') e.preventDefault(); }}
              onMouseEnter={() => setHovered(label)} onMouseLeave={() => setHovered(null)}
              style={{
                fontSize: 14.5, fontWeight: isActive ? 600 : 500, textDecoration: 'none',
                color: isActive ? 'var(--kl-mint)' : isHover ? '#fff' : 'rgba(255,255,255,.78)',
                transition: 'color .2s ease',
              }}>{label}</a>
          );
        })}
        <Button variant="dark-primary" size="sm" mono href={ctaHref} onClick={onCta}>{cta}</Button>
      </div>
    </nav>
  );
}
