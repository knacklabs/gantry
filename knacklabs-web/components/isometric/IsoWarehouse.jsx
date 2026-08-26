import React from 'react';
import { IsoLabel } from './IsoLabel.jsx';

/* Data warehouse / platform — two big disk tiers on a dashed axis
   (the Baseten "INFRA" silhouette in KnackLabs colors). */
export function IsoWarehouse({ size = 210, label, metric, metric2, axis = true, style }) {
  const R = (size - 10) / 2, ry = R * 0.42;
  const dh = size * 0.105, gap = size * 0.10;
  const cx = size / 2, t = ry + (axis ? 26 : 4);
  const H = t + dh + gap + dh + ry + (axis ? 26 : 6);
  const DEEP = 'var(--kl-deep-forest, #0C3529)';
  const EM = 'var(--kl-emerald, #1C6B49)';
  const tier = (cy, band) => {
    const side = 'M' + (cx - R) + ',' + cy + ' L' + (cx - R) + ',' + (cy + dh) +
      ' A' + R + ',' + ry + ' 0 0 0 ' + (cx + R) + ',' + (cy + dh) +
      ' L' + (cx + R) + ',' + cy;
    return (
      <g>
        <path d={side} fill={band} stroke={DEEP} strokeWidth="1.3" />
        <ellipse cx={cx} cy={cy} rx={R} ry={ry} fill="#E9FCF2" stroke={DEEP} strokeWidth="1.3" />
      </g>
    );
  };
  return (
    <div style={{ display: 'inline-block', position: 'relative', textAlign: 'center', ...style }}>
      <svg width={size} height={H} style={{ display: 'block', overflow: 'visible' }}>
        {axis ? <line x1={cx} y1={0} x2={cx} y2={t} stroke={EM} strokeWidth="1.2" strokeDasharray="3 4" /> : null}
        {tier(t + dh + gap, EM)}
        {tier(t, 'var(--kl-mint, #6AF1B0)')}
      </svg>
      {label ? (
        <div style={{ position: 'absolute', top: axis ? -14 : -22, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>
          <IsoLabel>{label}</IsoLabel>
        </div>
      ) : null}
      {metric ? (
        <div style={{ position: 'absolute', top: '38%', left: '88%', whiteSpace: 'nowrap' }}>
          <IsoLabel tone="outline" size="sm">{metric}</IsoLabel>
        </div>
      ) : null}
      {metric2 ? (
        <div style={{ position: 'absolute', top: '62%', right: '88%', whiteSpace: 'nowrap' }}>
          <IsoLabel tone="outline" size="sm">{metric2}</IsoLabel>
        </div>
      ) : null}
    </div>
  );
}
