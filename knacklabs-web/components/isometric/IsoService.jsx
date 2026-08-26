import React from 'react';
import { IsoLabel } from './IsoLabel.jsx';

/* Filled isometric cube — an API service, microservice, app module.
   Emerald faces, mint-tinted top with a mint highlight diamond. */
export function IsoService({ size = 110, label, metric, style }) {
  const W = size, hw = W / 2, h = W / 4, d = W * 0.42;
  const c = hw + 2, t = 2;
  const H = t + 2 * h + d + 2;
  const pt = (arr) => arr.map((p) => p.join(',')).join(' ');
  const top = [[c, t], [c + hw, t + h], [c, t + 2 * h], [c - hw, t + h]];
  const left = [[c - hw, t + h], [c, t + 2 * h], [c, t + 2 * h + d], [c - hw, t + h + d]];
  const right = [[c, t + 2 * h], [c + hw, t + h], [c + hw, t + h + d], [c, t + 2 * h + d]];
  const hi = 0.42; // top highlight diamond scale
  const hiD = [[c, t + h - h * hi], [c + hw * hi, t + h], [c, t + h + h * hi], [c - hw * hi, t + h]];
  const DEEP = 'var(--kl-deep-forest, #0C3529)';
  return (
    <div style={{ display: 'inline-block', position: 'relative', textAlign: 'center', ...style }}>
      <svg width={W + 4} height={H} style={{ display: 'block', overflow: 'visible' }}>
        <polygon points={pt(left)} fill="#174F37" stroke={DEEP} strokeWidth="1.2" strokeLinejoin="round" />
        <polygon points={pt(right)} fill="var(--kl-emerald, #1C6B49)" stroke={DEEP} strokeWidth="1.2" strokeLinejoin="round" />
        <polygon points={pt(top)} fill="#E3FAEF" stroke={DEEP} strokeWidth="1.2" strokeLinejoin="round" />
        <polygon points={pt(hiD)} fill="var(--kl-mint, #6AF1B0)" opacity="0.85" />
      </svg>
      {label ? <div style={{ marginTop: 8 }}><IsoLabel>{label}</IsoLabel></div> : null}
      {metric ? (
        <div style={{ position: 'absolute', top: -6, left: '78%', whiteSpace: 'nowrap' }}>
          <IsoLabel tone="outline" size="sm">{metric}</IsoLabel>
        </div>
      ) : null}
    </div>
  );
}
