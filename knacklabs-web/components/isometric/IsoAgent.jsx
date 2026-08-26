import React from 'react';
import { IsoLabel } from './IsoLabel.jsx';

/* AI Agent — a cube with a pulsing mint presence ring and a status chip.
   The pulse is the "this thing is alive and working" signal. */
export function IsoAgent({ size = 110, label, metric, status = 'live', animated = true, style }) {
  const W = size, hw = W / 2, h = W / 4, d = W * 0.42;
  const c = hw + 2, t = 2 + h * 0.9; // leave headroom for the pulse
  const H = t + 2 * h + d + 2;
  const pt = (arr) => arr.map((p) => p.join(',')).join(' ');
  const top = [[c, t], [c + hw, t + h], [c, t + 2 * h], [c - hw, t + h]];
  const left = [[c - hw, t + h], [c, t + 2 * h], [c, t + 2 * h + d], [c - hw, t + h + d]];
  const right = [[c, t + 2 * h], [c + hw, t + h], [c + hw, t + h + d], [c, t + 2 * h + d]];
  const hi = 0.42;
  const hiD = [[c, t + h - h * hi], [c + hw * hi, t + h], [c, t + h + h * hi], [c - hw * hi, t + h]];
  const DEEP = 'var(--kl-deep-forest, #0C3529)';
  const MINT = 'var(--kl-mint, #6AF1B0)';
  const pulse = (delay) => (
    <ellipse cx={c} cy={t + h} rx={hw * 0.6} ry={h * 0.6} fill="none" stroke={MINT} strokeWidth="1.5">
      <animate attributeName="rx" values={hw * 0.55 + ';' + hw * 1.18} dur="2.4s" begin={delay} repeatCount="indefinite" />
      <animate attributeName="ry" values={h * 0.55 + ';' + h * 1.18} dur="2.4s" begin={delay} repeatCount="indefinite" />
      <animate attributeName="opacity" values=".8;0" dur="2.4s" begin={delay} repeatCount="indefinite" />
    </ellipse>
  );
  return (
    <div style={{ display: 'inline-block', position: 'relative', textAlign: 'center', ...style }}>
      <svg width={W + 4} height={H} style={{ display: 'block', overflow: 'visible' }}>
        <polygon points={pt(left)} fill="#174F37" stroke={DEEP} strokeWidth="1.2" strokeLinejoin="round" />
        <polygon points={pt(right)} fill="var(--kl-emerald, #1C6B49)" stroke={DEEP} strokeWidth="1.2" strokeLinejoin="round" />
        <polygon points={pt(top)} fill="#E3FAEF" stroke={DEEP} strokeWidth="1.2" strokeLinejoin="round" />
        <polygon points={pt(hiD)} fill={MINT} opacity="0.9" />
        {animated ? pulse('0s') : null}
        {animated ? pulse('1.2s') : null}
        <circle cx={c + hw * 0.72} cy={t + h * 0.4} r="4.5" fill={MINT} stroke={DEEP} strokeWidth="1.2" />
      </svg>
      {label ? <div style={{ marginTop: 8 }}><IsoLabel>{label}</IsoLabel></div> : null}
      {status ? (
        <div style={{ position: 'absolute', top: -10, left: '74%', whiteSpace: 'nowrap' }}>
          <IsoLabel tone="solid" size="sm">{status}</IsoLabel>
        </div>
      ) : null}
      {metric ? (
        <div style={{ position: 'absolute', top: H * 0.46, left: '92%', whiteSpace: 'nowrap' }}>
          <IsoLabel tone="outline" size="sm">{metric}</IsoLabel>
        </div>
      ) : null}
    </div>
  );
}
