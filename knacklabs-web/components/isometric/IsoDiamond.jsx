import React from 'react';

/* Flat isometric diamond — the confetti element scattered around diagrams.
   A square mapped onto the iso ground plane. */
const ISO = '0.866 0.5 -0.866 0.5';

export function IsoDiamond({ size = 18, tone = 'mint', stacked = false, style }) {
  const fills = {
    mint: 'var(--kl-mint, #6AF1B0)',
    emerald: 'var(--kl-emerald, #1C6B49)',
    tint: 'rgba(106,241,176,.30)',
    outline: 'none',
  };
  const s = size / 1.732; // square side so total width = size
  const W = size + 4, H = size * 0.58 + (stacked ? 8 : 0) + 4;
  const cx = W / 2, cy = 2;
  const diamond = (dy, fill, op) => (
    <rect key={dy} x={-s / 2} y={-s / 2} width={s} height={s}
      transform={'translate(' + cx + ',' + (cy + size * 0.29 + dy) + ') matrix(' + ISO + ' 0 0)'}
      fill={fill} fillOpacity={op}
      stroke={tone === 'outline' ? 'var(--kl-deep-forest, #0C3529)' : 'none'} strokeWidth="1" />
  );
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible', ...style }}>
      {stacked ? diamond(8, fills[tone] === 'none' ? 'none' : fills[tone], 0.35) : null}
      {stacked ? diamond(4, fills[tone] === 'none' ? 'none' : fills[tone], 0.6) : null}
      {diamond(0, fills[tone] || fills.mint, tone === 'tint' ? 1 : 1)}
    </svg>
  );
}
