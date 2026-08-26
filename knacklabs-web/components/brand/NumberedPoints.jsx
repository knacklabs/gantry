import React from 'react';

/* Numbered points with circular mono counters — the production deck's
   list pattern. Emerald circles on light, Mint on dark. */
export function NumberedPoints({ items = [], onDark = false, start = 1, columns = 1, style }) {
  return (
    <ol style={{
      listStyle: 'none', margin: 0, padding: 0, display: 'grid',
      gridTemplateColumns: columns === 2 ? '1fr 1fr' : '1fr',
      gap: columns === 2 ? '18px 40px' : 18,
      fontFamily: 'var(--font-sans)', ...style,
    }}>
      {items.map((it, idx) => (
        <li key={idx} style={{ position: 'relative', paddingLeft: 52, fontSize: 17, lineHeight: 1.45, color: onDark ? 'var(--kl-text-on-dark)' : 'var(--kl-ink-2)' }}>
          <span style={{
            position: 'absolute', left: 0, top: -2, width: 34, height: 34, borderRadius: '50%',
            fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 15,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: onDark ? 'var(--kl-mint)' : 'var(--kl-emerald)',
            color: onDark ? 'var(--kl-deep-forest)' : '#fff',
          }}>{start + idx}</span>
          {it.title ? <b style={{ fontWeight: 700, color: onDark ? '#fff' : 'var(--kl-deep-forest)' }}>{it.title} </b> : null}
          {it.text}
        </li>
      ))}
    </ol>
  );
}
