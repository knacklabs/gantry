import React from 'react';
import { IsoLabel } from './IsoLabel.jsx';

/* Database — a stack of isometric disks with brand-colored bands
   (mint top, emerald middle, white base). */
export function IsoDatabase({ size = 120, disks = 3, label, metric, style }) {
  const R = (size - 8) / 2, ry = R * 0.48;
  const dh = size * 0.14, gap = size * 0.055;
  const cx = size / 2, t = ry + 3;
  const H = t + (disks - 1) * (dh + gap) + dh + ry + 4;
  const DEEP = 'var(--kl-deep-forest, #0C3529)';
  const bands = ['var(--kl-mint, #6AF1B0)', 'var(--kl-emerald, #1C6B49)', '#FFFFFF', 'rgba(106,241,176,.25)'];
  const disk = (i) => {
    const cy = t + i * (dh + gap);
    const side = 'M' + (cx - R) + ',' + cy + ' L' + (cx - R) + ',' + (cy + dh) +
      ' A' + R + ',' + ry + ' 0 0 0 ' + (cx + R) + ',' + (cy + dh) +
      ' L' + (cx + R) + ',' + cy;
    return (
      <g key={i}>
        <path d={side} fill={bands[i % bands.length]} stroke={DEEP} strokeWidth="1.2" />
        <ellipse cx={cx} cy={cy} rx={R} ry={ry} fill="#E9FCF2" stroke={DEEP} strokeWidth="1.2" />
      </g>
    );
  };
  const order = [];
  for (let i = disks - 1; i >= 0; i--) order.push(disk(i));
  return (
    <div style={{ display: 'inline-block', position: 'relative', textAlign: 'center', ...style }}>
      <svg width={size} height={H} style={{ display: 'block', overflow: 'visible' }}>{order}</svg>
      {label ? <div style={{ marginTop: 8 }}><IsoLabel>{label}</IsoLabel></div> : null}
      {metric ? (
        <div style={{ position: 'absolute', top: -4, left: '82%', whiteSpace: 'nowrap' }}>
          <IsoLabel tone="outline" size="sm">{metric}</IsoLabel>
        </div>
      ) : null}
    </div>
  );
}
