import React from 'react';
import { IsoLabel } from './IsoLabel.jsx';

/* Cloud / cluster — overlapping capsule pills lying on the iso plane
   (the Baseten cloud motif in KnackLabs colors). */
export function IsoCloud({ size = 140, label, metric, style }) {
  const sc = size / 140;
  const W = 140, H = 96;
  const cx = 64, cy = 26;
  const iso = 'matrix(0.866 0.5 -0.866 0.5 ';
  const pill = (ox, oy, fill, op) => (
    <rect x={-35} y={-12} width={70} height={24} rx={12}
      transform={'translate(' + (cx + 0.866 * (ox - oy)) + ',' + (cy + 0.5 * (ox + oy)) + ') ' + iso + '0 0)'}
      fill={fill} fillOpacity={op || 1} stroke="var(--kl-deep-forest, #0C3529)" strokeWidth="1.1" />
  );
  return (
    <div style={{ display: 'inline-block', position: 'relative', textAlign: 'center', ...style }}>
      <svg width={W * sc} height={H * sc} viewBox={'0 0 ' + W + ' ' + H} style={{ display: 'block', overflow: 'visible' }}>
        {pill(26, -14, '#FFFFFF')}
        {pill(0, 0, 'var(--kl-emerald, #1C6B49)')}
        {pill(-26, 14, 'rgba(106,241,176,.45)')}
        {pill(2, 30, 'var(--kl-mint, #6AF1B0)')}
      </svg>
      {label ? <div style={{ marginTop: 6 }}><IsoLabel>{label}</IsoLabel></div> : null}
      {metric ? (
        <div style={{ position: 'absolute', top: -8, left: '74%', whiteSpace: 'nowrap' }}>
          <IsoLabel tone="outline" size="sm">{metric}</IsoLabel>
        </div>
      ) : null}
    </div>
  );
}
